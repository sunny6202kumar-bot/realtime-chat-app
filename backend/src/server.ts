import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { createServer } from "http";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import crypto from "crypto";
import { auth, comparePassword, hashPassword, signUser } from "./auth";
import { uploadBuffer } from "./storage";

const prisma = new PrismaClient();
const app = express();
const httpServer = createServer(app);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

const io = new Server(httpServer, { cors: { origin: "*" } });
const online = new Set<string>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const registerSchema = z.object({
  email: z.string().email().transform(v => v.toLowerCase().trim()),
  password: z.string().min(6).max(200),
  displayName: z.string().trim().min(1).max(60)
});

const messageSchema = z.object({
  content: z.string().max(10000).optional(),
  messageType: z.enum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT"]).default("TEXT"),
  mediaUrl: z.string().url().optional(),
  fileName: z.string().max(255).optional(),
  fileSize: z.number().int().positive().optional(),
  mimeType: z.string().max(100).optional()
}).refine(v => v.messageType !== "TEXT" || !!v.content?.trim(), "Text message cannot be empty");

app.get("/health", (_req, res) => res.json({ ok: true, onlineUsers: online.size }));

app.post("/api/auth/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid registration data", details: parsed.error.issues });
  }
  try {
    const data = parsed.data;
    const exists = await prisma.user.findUnique({ where: { email: data.email } });
    if (exists) return res.status(409).json({ error: "Email already registered" });
    const user = await prisma.user.create({
      data: { email: data.email, displayName: data.displayName, passwordHash: await hashPassword(data.password) },
      select: { id: true, email: true, displayName: true, avatarUrl: true }
    });
    res.json({ token: signUser(user.id), user });
  } catch (err) {
    console.error("REGISTER_ERROR", err);
    res.status(500).json({ error: "Registration failed" });
  }
});
app.post("/api/auth/guest", async (_req, res) => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await prisma.user.create({
    data: {
      email: `guest-${Date.now()}-${suffix}@guest.local`,
      displayName: `Guest ${suffix.toUpperCase()}`,
      passwordHash: await hashPassword(crypto.randomUUID())
    },
    select: { id: true, email: true, displayName: true, avatarUrl: true }
  });
  res.json({ token: signUser(user.id), user });
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid login data" });
  const email = parsed.data.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await comparePassword(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  res.json({ token: signUser(user.id), user: {
    id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl
  }});
});

app.get("/api/me", auth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: (req as any).userId },
    select: { id: true, email: true, displayName: true, avatarUrl: true }
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ ...user, online: online.has(user.id) });
});

app.get("/api/users", auth, async (req, res) => {
  const me = (req as any).userId;
  const users = await prisma.user.findMany({
    where: { id: { not: me } },
    select: { id: true, displayName: true, email: true, avatarUrl: true }
  });
  res.json(users.map((u: any) => ({ ...u, online: online.has(u.id) })));
});

app.get("/api/conversations", auth, async (req, res) => {
  const userId = (req as any).userId;
  const memberships = await prisma.conversationMember.findMany({
    where: { userId },
    include: {
      conversation: {
        include: {
          members: { include: { user: { select: { id: true, displayName: true, email: true, avatarUrl: true } } } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 }
        }
      }
    },
  });
  const result = memberships.map((m: any) => {
    const other = m.conversation.members.find((x: any) => x.userId !== userId)?.user;
    const last = m.conversation.messages[0];
    return {
      id: m.conversation.id,
      user: other ? { ...other, online: online.has(other.id) } : null,
      lastMessage: last ? {
        id: last.id, content: last.content, messageType: last.messageType,
        createdAt: last.createdAt, senderId: last.senderId, status: last.status
      } : null
    };
  }).filter((x: any) => x.user);
  res.json(result);
});

app.post("/api/conversations/direct", auth, async (req, res) => {
  const me = (req as any).userId;
  const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success || parsed.data.userId === me) return res.status(400).json({ error: "Invalid user" });
  const other = parsed.data.userId;
  const existing = await prisma.conversation.findFirst({
    where: {
      isGroup: false,
      members: { every: { userId: { in: [me, other] } } }
    },
    include: { members: true }
  });
  if (existing && existing.members.length === 2) return res.json(existing);
  const conversation = await prisma.conversation.create({
    data: { members: { create: [{ userId: me }, { userId: other }] } }
  });
  res.json(conversation);
});

async function isMember(conversationId: string, userId: string) {
  return prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } }
  });
}

app.get("/api/conversations/:id/messages", auth, async (req, res) => {
  const userId = (req as any).userId;
  const conversationId = String(req.params.id);
  const take = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const before = req.query.before ? new Date(String(req.query.before)) : undefined;
  if (before && Number.isNaN(before.getTime())) return res.status(400).json({ error: "Invalid before cursor" });
  if (!(await isMember(conversationId, userId))) return res.status(403).json({ error: "Not a member" });

  const messages = await prisma.message.findMany({
    where: { conversationId, ...(before ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    include: { sender: { select: { id: true, displayName: true, avatarUrl: true } } }
  });
  const hasMore = messages.length > take;
  const page = messages.slice(0, take).reverse();
  res.json({ messages: page, hasMore });
});

app.post("/api/conversations/:id/messages", auth, async (req, res) => {
  const senderId = (req as any).userId;
  const conversationId = String(req.params.id);
  if (!(await isMember(conversationId, senderId))) return res.status(403).json({ error: "Not a member" });
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid message" });
  const data = parsed.data;
  if (data.messageType !== "TEXT" && !data.mediaUrl) return res.status(400).json({ error: "Attachment URL required" });

  const message = await prisma.message.create({
    data: { conversationId, senderId, ...data },
    include: { sender: { select: { id: true, displayName: true, avatarUrl: true } } }
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  io.to(`conversation:${conversationId}`).emit("message:new", message);
  res.json(message);
});

app.post("/api/uploads", auth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const mime = req.file.mimetype.toLowerCase();
  const isVideo = mime.startsWith("video/");
  const isImage = ["image/png","image/jpeg","image/jpg","image/gif","image/webp"].includes(mime);
  const allowedVideo = ["video/mp4","video/webm"].includes(mime);
  const allowedDoc = ["application/pdf","text/plain","application/zip","application/x-zip-compressed",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
  if (!(isImage || allowedVideo || allowedDoc)) return res.status(415).json({ error: "Unsupported file type" });
  if (isVideo && !allowedVideo) return res.status(415).json({ error: "Only MP4/WebM videos are supported" });
  const max = isVideo ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
  if (req.file.size > max) return res.status(413).json({ error: `File exceeds ${isVideo ? 50 : 20}MB limit` });
  try {
    const url = await uploadBuffer(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.json({ url, fileName: req.file.originalname, fileSize: req.file.size, mimeType: req.file.mimetype });
  } catch {
    res.status(500).json({ error: "Storage upload failed" });
  }
});

app.post("/api/messages/:id/read", auth, async (req, res) => {
  const userId = (req as any).userId;
  const message = await prisma.message.findUnique({ where: { id: String(req.params.id) } });
  if (!message || !(await isMember(message.conversationId, userId))) return res.status(404).json({ error: "Message not found" });
  if (message.senderId === userId) return res.json(message);
  const updated = await prisma.message.update({ where: { id: message.id }, data: { status: "READ" } });
  io.to(`conversation:${updated.conversationId}`).emit("message:status", { messageId: updated.id, status: "READ" });
  res.json(updated);
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Unauthorized"));
  try {
    const jwt = require("jsonwebtoken");
    const payload = jwt.verify(token, process.env.JWT_SECRET!);
    (socket as any).userId = payload.userId;
    next();
  } catch { next(new Error("Unauthorized")); }
});

io.on("connection", socket => {
  const userId = (socket as any).userId as string;
  online.add(userId);
  socket.join(`user:${userId}`);
  io.emit("presence:update", { userId, online: true });

  socket.on("conversation:join", async (conversationId: string) => {
    if (!(await isMember(conversationId, userId))) return;
    socket.join(`conversation:${conversationId}`);
    const delivered = await prisma.message.updateMany({
      where: { conversationId, senderId: { not: userId }, status: "SENT" },
      data: { status: "DELIVERED" }
    });
    if (delivered.count) {
      io.to(`conversation:${conversationId}`).emit("conversation:delivered", { conversationId });
    }
  });

  socket.on("conversation:leave", (conversationId: string) => socket.leave(`conversation:${conversationId}`));

  socket.on("message:read", async ({ messageId }: { messageId: string }) => {
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || !(await isMember(message.conversationId, userId)) || message.senderId === userId) return;
    const updated = await prisma.message.update({ where: { id: messageId }, data: { status: "READ" } });
    io.to(`conversation:${updated.conversationId}`).emit("message:status", { messageId, status: "READ" });
  });

  socket.on("disconnect", () => {
    online.delete(userId);
    io.emit("presence:update", { userId, online: false });
  });
});

const port = Number(process.env.PORT || 4000);
httpServer.listen(port, () => console.log(`API + Socket.IO listening on port ${port}`));
