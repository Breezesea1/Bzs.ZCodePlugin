import test from "node:test";
import assert from "node:assert/strict";
import {createBackend} from "../backend.mjs";

const config={
  sessionDb:"D:/no-such-db.sqlite",indexDb:"D:/no-such-index.sqlite",
  gatewayConfigPath:"D:/no-such-gateway.json",timeoutMs:5000,sqliteBin:"sqlite3",
  titlePolicyDirectory:"D:/no-such-policy"
};
const event={session_id:"sess_retry1",workspace_path:"D:\\w"};

test("call：gateway_rpc_protocol_error 按退避重连后成功",async()=>{
  const connects=[];let calls=0;
  // 首次连接的调用被瞬断（fault 已 reject 的连接不可复用），重连后成功
  const makeConnection=broken=>({call:async()=>{calls++;if(broken)throw Object.assign(new Error("断"),{reasonCode:"gateway_rpc_protocol_error"});return{ok:1};},close:()=>{}});
  const backend=createBackend({
    event,config,prompt:"p",retryDelaysMs:[1,1],
    connect:async()=>{
      connects.push(1);
      return makeConnection(connects.length===1);
    }
  });
  const result=await backend.models();
  assert.deepEqual(result,{ok:1});
  assert.equal(connects.length,2);
  assert.equal(calls,2);
});

test("call：非协议错误不重试直接抛出",async()=>{
  let connects=0;
  const backend=createBackend({
    event,config,prompt:"p",retryDelaysMs:[1,1],
    connect:async()=>{connects++;return{call:async()=>{throw new Error("业务错误");},close:()=>{}};}
  });
  await assert.rejects(()=>backend.models(),/业务错误/);
  assert.equal(connects,1);
});

test("call：退避次数用尽后抛出最后一次错误",async()=>{
  let connects=0;
  const backend=createBackend({
    event,config,prompt:"p",retryDelaysMs:[1,1],
    connect:async()=>{connects++;return{call:async()=>{throw Object.assign(new Error("断"),{reasonCode:"gateway_rpc_protocol_error"});},close:()=>{}};}
  });
  await assert.rejects(()=>backend.models(),error=>error.reasonCode==="gateway_rpc_protocol_error");
  assert.equal(connects,3); // 1 + 2 次重试
});

test("构造：无效 session_id 直接拒绝",()=>{
  assert.throws(()=>createBackend({event:{session_id:"bad"},config,prompt:"p"}),/session_id/);
});
