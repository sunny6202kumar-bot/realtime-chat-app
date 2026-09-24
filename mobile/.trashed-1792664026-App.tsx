import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Linking, Platform,
  Pressable, SafeAreaView, StyleSheet, Text, TextInput, View
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { VideoView, useVideoPlayer } from "expo-video";
import { io, Socket } from "socket.io-client";

const API = process.env.EXPO_PUBLIC_API_URL || "";
const SOCKET = process.env.EXPO_PUBLIC_SOCKET_URL || API;

type User = { id:string; displayName:string; email:string; avatarUrl?:string|null; online?:boolean };
type Message = { id:string; conversationId:string; senderId:string; content?:string|null; messageType:"TEXT"|"IMAGE"|"VIDEO"|"DOCUMENT"; mediaUrl?:string|null; fileName?:string|null; fileSize?:number|null; mimeType?:string|null; createdAt:string; status:"SENT"|"DELIVERED"|"READ"; sender:User };
type Chat = { id:string; user:User; lastMessage?:{content?:string|null;messageType:string;createdAt:string;senderId:string;status:string}|null };

async function api(path:string, options:RequestInit={}, token?:string) {
  const headers:Record<string,string> = {...(options.body instanceof FormData ? {} : {"Content-Type":"application/json"}), ...(options.headers as any || {})};
  if(token) headers.Authorization=`Bearer ${token}`;
  const r=await fetch(`${API}${path}`,{...options,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||"Request failed");
  return data;
}
function initials(name:string){return name.trim().split(/\s+/).map(x=>x[0]).join("").slice(0,2).toUpperCase();}
function formatTime(v:string){return new Date(v).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});}
function size(v?:number|null){if(!v)return ""; return v<1024*1024?`${Math.round(v/1024)} KB`:`${(v/1024/1024).toFixed(1)} MB`;}

export default function App(){
  const [token,setToken]=useState<string|null>(null), [me,setMe]=useState<User|null>(null), [loading,setLoading]=useState(true);
  const [users,setUsers]=useState<User[]>([]), [chats,setChats]=useState<Chat[]>([]), [active,setActive]=useState<Chat|null>(null);
  const [messages,setMessages]=useState<Message[]>([]), [text,setText]=useState(""), [socket,setSocket]=useState<Socket|null>(null);
  const [search,setSearch]=useState(""), [hasMore,setHasMore]=useState(false), [loadingMore,setLoadingMore]=useState(false), [uploading,setUploading]=useState(false), [uploadProgress,setUploadProgress]=useState(0);
  const listRef=useRef<FlatList<Message>>(null);

  useEffect(()=>{(async()=>{try{const t=await AsyncStorage.getItem("token"); const u=await AsyncStorage.getItem("user"); if(t&&u){setToken(t);setMe(JSON.parse(u));}}finally{setLoading(false)}})()},[]);
  useEffect(()=>{
    if(!token)return;
    Promise.all([api("/api/me",{},token),api("/api/users",{},token),api("/api/conversations",{},token)])
      .then(([m,u,c])=>{setMe(m);setUsers(u);setChats(c);AsyncStorage.setItem("user",JSON.stringify(m));}).catch(()=>logout());
    const s=io(SOCKET,{auth:{token}});
    s.on("message:new",(m:Message)=>{if(m.conversationId===active?.id)setMessages(p=>p.some(x=>x.id===m.id)?p:[...p,m]); refreshChats(token);});
    s.on("message:status",({messageId,status})=>setMessages(p=>p.map(m=>m.id===messageId?{...m,status}:m)));
    s.on("conversation:delivered",()=>setMessages(p=>p.map(m=>m.senderId===me?.id&&m.status==="SENT"?{...m,status:"DELIVERED"}:m)));
    s.on("presence:update",({userId,online}:{userId:string;online:boolean})=>{
      setUsers(p=>p.map(u=>u.id===userId?{...u,online}:u)); setChats(p=>p.map(c=>c.user.id===userId?{...c,user:{...c.user,online}}:c));
      setActive(p=>p&&p.user.id===userId?{...p,user:{...p.user,online}}:p);
    });
    setSocket(s); return()=>{s.disconnect();};
  },[token]);
  useEffect(()=>{if(active&&socket)socket.emit("conversation:join",active.id)},[active?.id,socket]);

  const refreshChats=async(t=token)=>{if(!t)return;try{setChats(await api("/api/conversations",{},t))}catch{}};
  const logout=async()=>{await AsyncStorage.multiRemove(["token","user"]);socket?.disconnect();setToken(null);setMe(null);setActive(null);};
  const openChat=async(u:User)=>{
    if(!token)return;
    const c=await api("/api/conversations/direct",{method:"POST",body:JSON.stringify({userId:u.id})},token);
    const page=await api(`/api/conversations/${c.id}/messages?limit=30`,{},token);
    const chat={id:c.id,user:u} as Chat;
    setActive(chat);setMessages(page.messages);setHasMore(page.hasMore);setSearch("");
    socket?.emit("conversation:join",c.id);
    page.messages.filter((m:Message)=>m.senderId!==me?.id&&m.status!=="READ").forEach((m:Message)=>socket?.emit("message:read",{messageId:m.id}));
  };
  const loadMore=async()=>{
    if(!token||!active||!hasMore||loadingMore||!messages.length)return;
    setLoadingMore(true); const before=messages[0].createdAt;
    try{const p=await api(`/api/conversations/${active.id}/messages?limit=30&before=${encodeURIComponent(before)}`,{},token);setMessages(x=>[...p.messages,...x]);setHasMore(p.hasMore)}finally{setLoadingMore(false)}
  };
  const sendText=async()=>{if(!token||!active||!text.trim())return;const content=text.trim();setText("");try{await api(`/api/conversations/${active.id}/messages`,{method:"POST",body:JSON.stringify({content,messageType:"TEXT"})},token)}catch(e:any){setText(content);Alert.alert("Error",e.message)}};
  const uploadAndSend=async(asset:any,type:"IMAGE"|"VIDEO"|"DOCUMENT")=>{
    if(!token||!active)return; setUploading(true);setUploadProgress(0);
    try{
      const result=await new Promise<any>((resolve,reject)=>{
        const xhr=new XMLHttpRequest(); xhr.open("POST",`${API}/api/uploads`);
        xhr.setRequestHeader("Authorization",`Bearer ${token}`);
        xhr.upload.onprogress=e=>{if(e.lengthComputable)setUploadProgress(Math.round(e.loaded/e.total*100))};
        xhr.onload=()=>{try{const d=JSON.parse(xhr.responseText);xhr.status>=200&&xhr.status<300?resolve(d):reject(new Error(d.error||"Upload failed"))}catch{reject(new Error("Upload failed"))}};
        xhr.onerror=()=>reject(new Error("Network error"));
        const form=new FormData();form.append("file",{uri:asset.uri,name:asset.name||asset.fileName||`upload-${Date.now()}`,type:asset.mimeType||asset.type||"application/octet-stream"} as any);xhr.send(form);
      });
      await api(`/api/conversations/${active.id}/messages`,{method:"POST",body:JSON.stringify({messageType:type,mediaUrl:result.url,fileName:result.fileName,fileSize:result.fileSize,mimeType:result.mimeType})},token);
    }catch(e:any){Alert.alert("Upload",e.message)}finally{setUploading(false);setUploadProgress(0)}
  };
  const pickMedia=async()=>{const r=await ImagePicker.launchImageLibraryAsync({mediaTypes:["images","videos"] as any,quality:.85});if(!r.canceled){const a=r.assets[0];await uploadAndSend(a,a.type==="video"?"VIDEO":"IMAGE")}};
  const pickDoc=async()=>{const r=await DocumentPicker.getDocumentAsync({copyToCacheDirectory:true});if(!r.canceled)await uploadAndSend(r.assets[0],"DOCUMENT")};

  if(loading)return <View style={styles.center}><ActivityIndicator size="large"/></View>;
  if(!token)return <Auth onLogin={(t,u)=>{setToken(t);setMe(u);AsyncStorage.multiSet([["token",t],["user",JSON.stringify(u)]])}}/>;

  const filteredUsers=users.filter(u=>(u.displayName+" "+u.email).toLowerCase().includes(search.toLowerCase()));
  if(active)return <ChatScreen me={me!} active={active} messages={messages} text={text} setText={setText} sendText={sendText} pickMedia={pickMedia} pickDoc={pickDoc} loadMore={loadMore} hasMore={hasMore} loadingMore={loadingMore} listRef={listRef} uploading={uploading} uploadProgress={uploadProgress} onBack={()=>setActive(null)} onLogout={logout}/>;

  return <SafeAreaView style={styles.safe}><View style={styles.homeHeader}><View><Text style={styles.brand}>Chats</Text><Text style={styles.sub}>Hi, {me?.displayName}</Text></View><Pressable onPress={logout}><Text style={styles.logout}>Log out</Text></Pressable></View>
    <View style={styles.searchBox}><TextInput placeholder="Search people..." value={search} onChangeText={setSearch} style={styles.searchInput}/></View>
    <FlatList data={search?filteredUsers:chats.map(c=>c.user)} keyExtractor={u=>u.id} contentContainerStyle={styles.list} renderItem={({item})=><Pressable style={styles.userRow} onPress={()=>openChat(item)}>
      <Avatar user={item}/><View style={{flex:1}}><View style={styles.rowTop}><Text style={styles.userName}>{item.displayName}</Text><View style={[styles.dot,{backgroundColor:item.online?"#22c55e":"#cbd5e1"}]}/></View><Text style={styles.muted}>{item.online?"Online":item.email}</Text></View>
    </Pressable>}/></SafeAreaView>;
}

function Avatar({user,sizePx=46}:{user:User;sizePx?:number}){return user.avatarUrl?<Image source={{uri:user.avatarUrl}} style={{width:sizePx,height:sizePx,borderRadius:sizePx/2}}/>:<View style={[styles.avatar,{width:sizePx,height:sizePx,borderRadius:sizePx/2}]}><Text style={styles.avatarText}>{initials(user.displayName)}</Text></View>}
function ChatScreen(p:any){
  return <SafeAreaView style={styles.safe}><KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":undefined}>
    <View style={styles.chatHeader}><Pressable onPress={p.onBack}><Text style={styles.back}>‹</Text></Pressable><Avatar user={p.active.user} sizePx={42}/><View style={{flex:1,marginLeft:10}}><Text style={styles.headerTitle}>{p.active.user.displayName}</Text><Text style={styles.muted}>{p.active.user.online?"Online":"Offline"}</Text></View><Pressable onPress={p.onLogout}><Text style={styles.logout}>↪</Text></Pressable></View>
    <FlatList ref={p.listRef} data={[...p.messages].reverse()} keyExtractor={(m:Message)=>m.id} inverted onEndReached={p.loadMore} onEndReachedThreshold={.15} contentContainerStyle={styles.messages} ListHeaderComponent={p.loadingMore?<ActivityIndicator/>:null} renderItem={({item}:{item:Message})=><Bubble item={item} mine={item.senderId===p.me.id}/>} />
    {p.uploading&&<View style={styles.progress}><Text style={styles.muted}>Uploading… {p.uploadProgress}%</Text><View style={styles.progressTrack}><View style={[styles.progressFill,{width:`${p.uploadProgress}%`}]}/></View></View>}
    <View style={styles.inputBar}><Pressable style={styles.attach} onPress={p.pickMedia}><Text style={styles.icon}>＋</Text></Pressable><Pressable style={styles.attach} onPress={p.pickDoc}><Text style={styles.icon}>📎</Text></Pressable><TextInput style={styles.input} value={p.text} onChangeText={p.setText} placeholder="Message…" multiline/><Pressable style={styles.send} onPress={p.sendText}><Text style={styles.sendText}>➤</Text></Pressable></View>
  </KeyboardAvoidingView></SafeAreaView>
}
function Bubble({item,mine}:{item:Message;mine:boolean}){
  return <View style={[styles.bubble,mine?styles.mine:styles.theirs]}>
    {item.messageType==="IMAGE"&&item.mediaUrl?<Image source={{uri:item.mediaUrl}} style={styles.image}/>:item.messageType==="VIDEO"&&item.mediaUrl?<VideoBubble url={item.mediaUrl}/>:item.messageType==="DOCUMENT"&&item.mediaUrl?<Pressable onPress={()=>Linking.openURL(item.mediaUrl!)} style={styles.fileCard}><Text style={styles.fileIcon}>📄</Text><View style={{flex:1}}><Text numberOfLines={1} style={styles.fileName}>{item.fileName||"Document"}</Text><Text style={styles.muted}>{size(item.fileSize)} · Tap to open</Text></View></Pressable>:null}
    {item.content&&<Text style={styles.messageText}>{item.content}</Text>}
    <Text style={styles.time}>{formatTime(item.createdAt)}{mine?` · ${item.status.toLowerCase()}`:""}</Text>
  </View>
}
function VideoBubble({url}:{url:string}){const player=useVideoPlayer(url,p=>{p.loop=false});return <VideoView player={player} style={styles.video} nativeControls/>}
function Auth({onLogin}:{onLogin:(t:string,u:User)=>void}){
  const [register,setRegister]=useState(true),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[name,setName]=useState(""),[busy,setBusy]=useState(false);
  const submit=async()=>{setBusy(true);try{const d=await api(register?"/api/auth/register":"/api/auth/login",{method:"POST",body:JSON.stringify(register?{email,password,displayName:name}:{email,password})});onLogin(d.token,d.user)}catch(e:any){Alert.alert("Error",e.message)}finally{setBusy(false)}};
  return <SafeAreaView style={styles.safe}><View style={styles.auth}><Text style={styles.logo}>Real-time Chat</Text><Text style={styles.authSub}>{register?"Create your account":"Welcome back"}</Text>{register&&<TextInput style={styles.authInput} placeholder="Display name" value={name} onChangeText={setName}/>}<TextInput style={styles.authInput} placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}/><TextInput style={styles.authInput} placeholder="Password (6+ characters)" secureTextEntry value={password} onChangeText={setPassword}/><Pressable style={styles.primaryButton} onPress={submit} disabled={busy}><Text style={styles.primaryText}>{busy?"Please wait…":register?"Create account":"Log in"}</Text></Pressable>
    <Pressable style={styles.guestButton} onPress={async()=>{setBusy(true);try{const d=await api("/api/auth/guest",{method:"POST"});onLogin(d.token,d.user)}catch(e:any){Alert.alert("Guest mode",e.message)}finally{setBusy(false)}}}><Text style={styles.guestText}>Continue as guest</Text></Pressable>
    <Pressable onPress={()=>setRegister(!register)}><Text style={styles.link}>{register?"Already have an account? Log in":"Create an account"}</Text></Pressable></View></SafeAreaView>
}
const styles=StyleSheet.create({
safe:{flex:1,backgroundColor:"#f6f8fc"},center:{flex:1,alignItems:"center",justifyContent:"center"},homeHeader:{padding:18,flexDirection:"row",alignItems:"center",justifyContent:"space-between",backgroundColor:"#fff"},brand:{fontSize:28,fontWeight:"800",color:"#111827"},sub:{color:"#64748b",marginTop:3},logout:{color:"#2563eb",fontWeight:"700"},searchBox:{padding:12,backgroundColor:"#fff"},searchInput:{backgroundColor:"#f1f5f9",borderRadius:14,padding:12},list:{padding:10},userRow:{flexDirection:"row",alignItems:"center",gap:12,padding:13,backgroundColor:"#fff",borderRadius:16,marginBottom:8},avatar:{backgroundColor:"#dbeafe",alignItems:"center",justifyContent:"center"},avatarText:{fontWeight:"800",color:"#1d4ed8"},rowTop:{flexDirection:"row",alignItems:"center",gap:7},dot:{width:8,height:8,borderRadius:4},userName:{fontWeight:"700",fontSize:16},muted:{color:"#64748b",fontSize:12},chatHeader:{height:64,backgroundColor:"#fff",flexDirection:"row",alignItems:"center",paddingHorizontal:12,borderBottomWidth:1,borderColor:"#e2e8f0"},back:{fontSize:38,lineHeight:38,color:"#2563eb",marginRight:5},headerTitle:{fontWeight:"800",fontSize:17},messages:{padding:12,paddingBottom:8},bubble:{maxWidth:"84%",padding:9,borderRadius:16,marginVertical:4},mine:{alignSelf:"flex-end",backgroundColor:"#dbeafe",borderBottomRightRadius:4},theirs:{alignSelf:"flex-start",backgroundColor:"#fff",borderBottomLeftRadius:4},messageText:{fontSize:16,lineHeight:21},time:{fontSize:9,color:"#64748b",marginTop:5,alignSelf:"flex-end"},image:{width:230,height:190,borderRadius:12},video:{width:240,height:190,borderRadius:12},fileCard:{minWidth:220,maxWidth:280,flexDirection:"row",alignItems:"center",gap:10,padding:10,backgroundColor:"#f1f5f9",borderRadius:12},fileIcon:{fontSize:28},fileName:{fontWeight:"700",flexShrink:1},inputBar:{flexDirection:"row",alignItems:"flex-end",gap:5,padding:8,backgroundColor:"#fff",borderTopWidth:1,borderColor:"#e2e8f0"},attach:{padding:8},icon:{fontSize:20},input:{flex:1,maxHeight:110,minHeight:42,backgroundColor:"#f1f5f9",borderRadius:20,paddingHorizontal:14,paddingVertical:10,fontSize:15},send:{width:44,height:44,borderRadius:22,backgroundColor:"#2563eb",alignItems:"center",justifyContent:"center"},sendText:{color:"#fff",fontSize:19},progress:{paddingHorizontal:14,paddingTop:6,backgroundColor:"#fff"},progressTrack:{height:5,borderRadius:3,backgroundColor:"#e2e8f0",marginVertical:5},progressFill:{height:5,borderRadius:3,backgroundColor:"#2563eb"},auth:{flex:1,justifyContent:"center",padding:24},logo:{fontSize:32,fontWeight:"900",color:"#111827"},authSub:{fontSize:16,color:"#64748b",marginBottom:25},authInput:{backgroundColor:"#fff",padding:14,borderRadius:12,marginBottom:12,borderWidth:1,borderColor:"#e2e8f0"} as any,primaryButton:{backgroundColor:"#2563eb",padding:15,borderRadius:12,alignItems:"center"},primaryText:{color:"#fff",fontWeight:"800"},guestButton:{padding:14,alignItems:"center",marginTop:6},guestText:{color:"#2563eb",fontWeight:"700"},link:{color:"#2563eb",textAlign:"center",marginTop:16,fontWeight:"600"}
});
