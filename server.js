import express from "express";
import helmet from "helmet";
import archiver from "archiver";
import { PassThrough } from "node:stream";

const app=express();
app.use(helmet({crossOriginResourcePolicy:{policy:"cross-origin"}}));
app.use(express.json({limit:"2mb"}));
const PORT=process.env.PORT||8080;
const API_KEY=process.env.AI_API_KEY;
const AI_BASE=(process.env.AI_BASE_URL||"https://api.openai.com/v1").replace(/\/+$/,"");
const AI_MODEL=process.env.AI_MODEL||"gpt-4.1-mini";
const APP_ACCESS_TOKEN=process.env.APP_ACCESS_TOKEN||"";
const allowedOrigin=process.env.ALLOWED_ORIGIN||"*";
app.use((req,res,next)=>{res.setHeader("Access-Control-Allow-Origin",allowedOrigin);res.setHeader("Access-Control-Allow-Headers","Content-Type,x-app-token");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");if(req.method==="OPTIONS")return res.sendStatus(204);next()});
const buckets=new Map();
function rateLimit(req,res,next){
 const ip=req.headers["x-forwarded-for"]?.split(",")[0]?.trim()||req.socket.remoteAddress||"unknown";
 const now=Date.now(),entry=buckets.get(ip)||{start:now,count:0};
 if(now-entry.start>60000){entry.start=now;entry.count=0}
 entry.count++;buckets.set(ip,entry);
 if(entry.count>20)return res.status(429).json({error:"बहुत अधिक अनुरोध। एक मिनट बाद कोशिश करें।"});
 next();
}
app.use("/api",rateLimit);
app.use("/api",(req,res,next)=>{
 if(APP_ACCESS_TOKEN && req.headers["x-app-token"]!==APP_ACCESS_TOKEN)return res.status(401).json({error:"Backend access token गलत है।"});
 next();
});
app.get("/health",(req,res)=>res.json({ok:true,service:"Genius APK Studio backend"}));
app.post("/api/generate",async(req,res)=>{
 if(!API_KEY)return res.status(503).json({error:"Server पर AI_API_KEY configured नहीं है। इसे hosting provider के Secrets/Environment में जोड़ें।"});
 const {name="My App",idea,template="blank",language="Hindi"}=req.body||{};
 if(typeof idea!=="string"||idea.trim().length<5||idea.length>12000)return res.status(400).json({error:"ऐप का विचार 5 से 12,000 characters के बीच लिखें।"});
 const system=`You are a senior mobile-first product designer and frontend engineer. Return ONLY valid JSON with one key html. Build a complete polished, responsive, accessible single-page app using inline HTML, CSS and vanilla JavaScript. No external scripts, no remote fonts, no API keys, no server secrets. Use ${language}. App name: ${String(name).slice(0,60)}. Starter: ${String(template).slice(0,40)}. Requirements: working interactions, form validation, navigation, useful empty/loading/error/success states, localStorage only for non-sensitive demo data. Avoid claiming payments/authentication/backend work unless implemented.`;
 try{
  const response=await fetch(AI_BASE+"/chat/completions",{method:"POST",headers:{"Authorization":`Bearer ${API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:AI_MODEL,temperature:0.4,response_format:{type:"json_object"},messages:[{role:"system",content:system},{role:"user",content:idea.trim()}]})});
  const raw=await response.text();if(!response.ok)return res.status(502).json({error:`AI provider error (${response.status}): ${raw.slice(0,700)}`});
  const data=JSON.parse(raw);let content=data.choices?.[0]?.message?.content||"";
  const parsed=JSON.parse(content);if(typeof parsed.html!=="string"||parsed.html.length>800000)return res.status(502).json({error:"AI response में valid HTML नहीं मिला।"});
  res.json({html:parsed.html});
 }catch(e){res.status(502).json({error:"AI request असफल: "+e.message})}
});
function safeName(s){return String(s||"MyApp").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,35)||"MyApp"}
function projectFiles(appName,html){
 const pkg="com.genius.generated";
 const manifest=`<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:theme="@android:style/Theme.Material.Light.NoActionBar" android:label="${appName}" android:allowBackup="false" android:usesCleartextTraffic="false"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>`;
 const java=`package ${pkg};\nimport android.app.Activity;import android.os.Bundle;import android.webkit.WebView;import android.webkit.WebSettings;\npublic class MainActivity extends Activity{public void onCreate(Bundle b){super.onCreate(b);WebView w=new WebView(this);WebSettings s=w.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);w.loadUrl("file:///android_asset/index.html");setContentView(w);}}\n`;
 const gradle=`plugins { id 'com.android.application' version '8.7.3' }\nandroid { namespace '${pkg}'; compileSdk 35; defaultConfig { applicationId '${pkg}'; minSdk 23; targetSdk 35; versionCode 1; versionName '1.0' } }\n`;
 const settings=`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }; dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }; rootProject.name='${appName}'; include ':app'\n`;
 const workflow=`name: Build generated app\non: [workflow_dispatch]\njobs:\n build:\n  runs-on: ubuntu-latest\n  steps:\n   - uses: actions/checkout@v4\n   - uses: actions/setup-java@v4\n     with: {distribution: temurin, java-version: '17'}\n   - uses: android-actions/setup-android@v3\n   - run: sdkmanager "platforms;android-35" "build-tools;35.0.0"\n   - uses: gradle/actions/setup-gradle@v4\n     with: {gradle-version: '8.9'}\n   - run: gradle assembleDebug\n   - uses: actions/upload-artifact@v4\n     with: {name: generated-app-debug, path: app/build/outputs/apk/debug/*.apk}\n`;
 return {
  "settings.gradle":settings,
  "build.gradle":"plugins { id 'com.android.application' version '8.7.3' apply false }\n",
  "gradle.properties":"org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\n",
  "app/build.gradle":gradle,
  "app/src/main/AndroidManifest.xml":manifest,
  "app/src/main/java/com/genius/generated/MainActivity.java":java,
  "app/src/main/assets/index.html":html,
  ".github/workflows/android.yml":workflow,
  "README_HI.md":"# "+appName+"\n\nGenerated Android WebView project. Open with Android Studio or upload files to GitHub and run Actions workflow. JDK 17, Android SDK 35, Gradle 8.9.\n"
 };
}
app.post("/api/export/android",async(req,res)=>{
 const {name="MyApp",html}=req.body||{};
 if(typeof html!=="string"||html.length<20||html.length>1000000)return res.status(400).json({error:"HTML project content missing or too large."});
 const appName=safeName(name),files=projectFiles(appName,html);
 res.setHeader("Content-Type","application/zip");res.setHeader("Content-Disposition",'attachment; filename="AndroidStudioProject.zip"');
 const archive=archiver("zip",{zlib:{level:8}});archive.on("error",e=>{if(!res.headersSent)res.status(500);res.end()});archive.pipe(res);
 for(const [path,content] of Object.entries(files))archive.append(content,{name:appName+"/"+path});
 archive.finalize();
});
app.listen(PORT,()=>console.log(`Genius APK Studio backend listening on ${PORT}`));
