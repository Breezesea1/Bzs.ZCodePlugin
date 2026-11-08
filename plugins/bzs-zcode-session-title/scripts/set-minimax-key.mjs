// 凭据写入工具：把 MiniMax API key 以 enc:v1（AES-256-GCM）加密进 credentials.json。
// 与 Desktop 的凭据加密同套机制（口令派生同 modelcall.credentialSecret），仅本机同用户可解。
//
// 用法：
//   node set-minimax-key.mjs --key "<API_KEY>"          # 写入/更新
//   node set-minimax-key.mjs --check                     # 校验条目存在且可解密
//   node set-minimax-key.mjs --clear                     # 移除条目
//
// 写入前备份原文件为 credentials.json.bak-minimax（同目录，覆盖旧备份）。
import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";
import {homedir, platform, userInfo} from "node:os";
import {join} from "node:path";
import {readFileSync, writeFileSync, copyFileSync, existsSync} from "node:fs";

const KEY_NAME="oauth:minimax:api_key";
const CREDENTIALS=join(homedir(),".zcode","v2","credentials.json");

function secret() {
  const explicit=process.env.ZCODE_CREDENTIAL_SECRET;
  if(explicit)return explicit;
  let user="unknown";
  try {user=userInfo().username;}catch {}
  return `zcode-credential-fallback:${platform()}:${homedir()}:${user}`;
}

function encrypt(plain) {
  const iv=randomBytes(12);
  const key=createHash("sha256").update(secret()).digest();
  const cipher=createCipheriv("aes-256-gcm",key,iv);
  const data=Buffer.concat([cipher.update(plain,"utf8"),cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}

function decrypt(stored) {
  if(!stored.startsWith("enc:v1:"))return stored;
  const [iv,tag,data]=stored.slice(7).split(".");
  const key=createHash("sha256").update(secret()).digest();
  const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64url"));
  decipher.setAuthTag(Buffer.from(tag,"base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data,"base64url")),decipher.final()]).toString("utf8").trim();
}

function parseArgs(argv) {
  const out={};
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==="--key")out.key=argv[++i];
    else if(argv[i]==="--check")out.check=true;
    else if(argv[i]==="--clear")out.clear=true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return out;
}

const args=parseArgs(process.argv.slice(2));
if(!existsSync(CREDENTIALS)) {
  console.error(`凭据文件不存在：${CREDENTIALS}`);
  process.exit(1);
}
const raw=readFileSync(CREDENTIALS,"utf8");
let store;
try {store=JSON.parse(raw);}catch {console.error("凭据文件 JSON 无效，拒绝修改");process.exit(1);}

if(args.check) {
  const stored=store[KEY_NAME];
  if(!stored){console.log("未设置");process.exit(2);}
  try {
    const plain=decrypt(stored);
    console.log(`已设置且可解密（长度 ${plain.length}，前 4 位 ${plain.slice(0,4)}…）`);
  }catch(error) {
    console.error("已设置但解密失败："+error.message);
    process.exit(1);
  }
} else if(args.clear) {
  if(!(KEY_NAME in store)){console.log("本来就没有该条目");process.exit(0);}
  copyFileSync(CREDENTIALS,`${CREDENTIALS}.bak-minimax`);
  delete store[KEY_NAME];
  writeFileSync(CREDENTIALS,JSON.stringify(store,null,2));
  console.log("已移除（备份在 credentials.json.bak-minimax）");
} else if(args.key) {
  const key=args.key.trim();
  if(key.length<8) {console.error("key 看起来太短，拒绝写入");process.exit(1);}
  copyFileSync(CREDENTIALS,`${CREDENTIALS}.bak-minimax`);
  store[KEY_NAME]=encrypt(key);
  writeFileSync(CREDENTIALS,JSON.stringify(store,null,2));
  // 写入后立即读回校验
  const roundtrip=decrypt(JSON.parse(readFileSync(CREDENTIALS,"utf8"))[KEY_NAME]);
  if(roundtrip!==key) {console.error("写后校验失败！请从备份恢复："+`${CREDENTIALS}.bak-minimax`);process.exit(1);}
  console.log("已加密写入并校验通过（备份在 credentials.json.bak-minimax）");
} else {
  console.error("请给 --key <API_KEY> / --check / --clear 之一");
  process.exit(1);
}
