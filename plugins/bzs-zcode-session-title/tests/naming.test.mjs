import test from "node:test";
import assert from "node:assert/strict";
import {titleFormatError,candidateFrom,runNaming} from "../naming.mjs";

const fmt={maxTitleChars:48,minTitleChars:6};

test("标题格式：合法的 emoji 对象｜目标",()=>{
  assert.equal(titleFormatError("🧩 邮箱验证码｜过期修复",fmt),null);
  assert.equal(titleFormatError("🔎 H3 / H3 Max｜模型对比",fmt),null);
});

test("标题格式：拒绝缺 emoji、缺分隔符、半角 |、过长",()=>{
  assert.ok(titleFormatError("邮箱验证码｜过期修复",fmt));
  assert.ok(titleFormatError("🧩 邮箱验证码 过期修复",fmt));
  assert.ok(titleFormatError("🧩 邮箱验证码|过期修复",fmt));
  assert.ok(titleFormatError("🧩 "+"长".repeat(48)+"｜目标",fmt));
  assert.ok(titleFormatError("🧩 短｜x",{...fmt,minTitleChars:10}));
});

test("标题格式：拒绝私有信息与控制字符",()=>{
  assert.ok(titleFormatError("🧩 sk-abc123｜修复",fmt));
  assert.ok(titleFormatError("🧩 C:\\秘密｜修复",fmt));
  assert.ok(titleFormatError("🧩 邮箱\u200b｜修复",fmt));
});

test("标题格式：requireFormat=false 只查长度与空白",()=>{
  assert.equal(titleFormatError("普通标题没有格式",{...fmt,requireFormat:false}),null);
  assert.ok(titleFormatError("  前后空格 ",{...fmt,requireFormat:false}));
});

test("candidateFrom：字段严格校验",()=>{
  const ok={finishReason:"stop",text:JSON.stringify({action:"rename",title:"🧩 邮箱注册｜验证码修复",reason:"主线明确"})};
  assert.equal(candidateFrom(ok,"旧标题",fmt).title,"🧩 邮箱注册｜验证码修复");
  assert.throws(()=>candidateFrom({finishReason:"length",text:ok.text},"旧",fmt),/结束原因/);
  assert.throws(()=>candidateFrom({finishReason:"stop",toolCalls:[{}],text:ok.text},"旧",fmt),/工具调用/);
  assert.throws(()=>candidateFrom({finishReason:"stop",text:"not json"},"旧",fmt));
  assert.throws(()=>candidateFrom({finishReason:"stop",text:JSON.stringify({action:"rename",title:1,reason:"x"})},"旧",fmt),/字段无效/);
});

test("candidateFrom：keep 时 title 回落为原标题",()=>{
  const result={finishReason:"stop",text:JSON.stringify({action:"keep",title:"保持原样",reason:"无需改动"})};
  assert.equal(candidateFrom(result,"🧩 合规的｜原标题",fmt).title,"🧩 合规的｜原标题");
});

test("candidateFrom：keep 但原标题违规时标记 invalid_keep_title",()=>{
  // 当前标题不符合统一结构时，keep 沿用违规标题 → 必须标记让调用方重试
  const result={finishReason:"stop",text:JSON.stringify({action:"keep",title:"随意",reason:"x"})};
  try {candidateFrom(result,"不合规的旧标题没有分隔符",fmt);assert.fail("应当抛出");}
  catch(error){assert.equal(error.code,"invalid_keep_title");}
  // 对照：原标题合规时 keep 正常返回
  const ok={finishReason:"stop",text:JSON.stringify({action:"keep",title:"随意",reason:"x"})};
  assert.equal(candidateFrom(ok,"🧩 正常｜标题",fmt).title,"🧩 正常｜标题");
});

test("candidateFrom：容错提取带尾随文本、围栏外说明或重复一致决策块的 JSON",()=>{
  const obj={action:"keep",title:"🧩 工作区运行状态｜修复验收发现问题",reason:"主线仍是修复验收问题"};
  // 复现线上错误："Unexpected non-whitespace character after JSON at position 72 (line 3 column 1)"
  const withTrailing=JSON.stringify(obj)+"\n\n注：当前标题结构已合规";
  assert.equal(candidateFrom({finishReason:"stop",text:withTrailing},obj.title,fmt).title,obj.title);

  const fencedWithProse="分析如下 {未闭合：\n```json\n"+JSON.stringify({action:"rename",title:"🧩 邮箱注册｜验证码修复",reason:"修复 \"}\" 与 {id} 解析"})+"\n```\n以上";
  const fromFence=candidateFrom({finishReason:"stop",text:fencedWithProse},"旧标题",fmt);
  assert.equal(fromFence.action,"rename");
  assert.equal(fromFence.title,"🧩 邮箱注册｜验证码修复");

  const withPrefixObj="参考 {\"ignored\":1} 后决定：\n"+JSON.stringify(obj);
  assert.equal(candidateFrom({finishReason:"stop",text:withPrefixObj},obj.title,fmt).action,"keep");

  const duplicated=JSON.stringify(obj)+"\n\n"+JSON.stringify(obj);
  assert.equal(candidateFrom({finishReason:"stop",text:duplicated},obj.title,fmt).action,"keep");

  const conflicting=JSON.stringify(obj)+"\n"+JSON.stringify({action:"rename",title:"🧩 其他｜不同标题",reason:"冲突"});
  assert.throws(()=>candidateFrom({finishReason:"stop",text:conflicting},obj.title,fmt),err=>err.reasonCode==="model_output_invalid"&&/不一致/.test(err.message));

  assert.throws(()=>candidateFrom({finishReason:"stop",text:"纯说明文字无 JSON"},obj.title,fmt),err=>err.reasonCode==="model_output_invalid");
});

test("runNaming：invalid_keep_title 二次仍 keep 且响应附带尾随文本时正常回落",async()=>{
  const {backend}=makeBackend({
    read:async()=>({...baseRead,title:"你好"}),
    generate:async context=>({
      finishReason:"stop",
      text:JSON.stringify({action:"keep",title:"你好",reason:context.title_format_feedback?"仍为问候":"仅问候"})+"\n\n说明：信息不足"
    })
  });
  const result=await runNaming({backend,selection:{},apply:false});
  assert.equal(result.action,"keep");
  assert.equal(result.title,"你好");
  assert.equal(result.reason,"仍为问候");
});

test("candidateFrom：reason 含敏感信息时拒绝",()=>{
  const result={finishReason:"stop",text:JSON.stringify({action:"rename",title:"🧩 邮箱注册｜修复",reason:"见 https://example.com"})};
  assert.throws(()=>candidateFrom(result,"旧",fmt),/链接、凭据或私人路径/);
});

// ---- runNaming 状态机 ----
function makeBackend({read,generate,rename:renameImpl}) {
  const saved=[];
  return {
    backend:{
      read,generate,
      rename:renameImpl??(async title=>({taskId:"s1",title})),
      saveState:async state=>saved.push(state)
    },
    saved
  };
}

const baseRead={
  title:"🧩 邮箱注册｜验证码过期",
  titleSource:"first_input",
  titlePolicy:null,
  archived:false,deleted:false,running:false,
  turnCount:3,fingerprint:"f1",latestUserId:"m3",
  context:{current_title:"首轮输入",original_goal:"做邮箱",recent_turns:[]}
};

test("runNaming：空会话与运行中直接跳过",async()=>{
  const a=makeBackend({read:async()=>({...baseRead,turnCount:0}),generate:async()=>{throw new Error("不应调用");}});
  assert.equal((await runNaming({backend:a.backend,selection:{}})).status,"empty");
  const b=makeBackend({read:async()=>({...baseRead,running:true}),generate:async()=>{throw new Error("不应调用");}});
  assert.equal((await runNaming({backend:b.backend,selection:{}})).status,"running");
  const c=makeBackend({read:async()=>({...baseRead,archived:true}),generate:async()=>{throw new Error("不应调用");}});
  assert.equal((await runNaming({backend:c.backend,selection:{}})).status,"archived");
});

test("runNaming：锁定的会话不生成",async()=>{
  const gen=async()=>{throw new Error("不应调用");};
  const policyRead={...baseRead,titlePolicy:{locked:true}};
  const a=makeBackend({read:async()=>policyRead,generate:gen});
  assert.equal((await runNaming({backend:a.backend,selection:{}})).status,"locked");
  const b=makeBackend({read:async()=>baseRead,generate:gen});
  assert.equal((await runNaming({backend:b.backend,selection:{},state:{locked:true}})).status,"locked");
});

test("runNaming：用户手动改名后锁定",async()=>{
  const {backend,saved}=makeBackend({
    read:async()=>baseRead,
    generate:async()=>{throw new Error("不应调用");}
  });
  const result=await runNaming({backend,selection:{},apply:true,state:{lastFingerprint:"f0",lastTitle:"旧标题"}});
  assert.equal(result.status,"manual_title");
  assert.equal(saved[0].locked,true);
});

test("runNaming：宿主 generated 改名不触发手动锁，继续命名",async()=>{
  let calls=0;
  const {backend}=makeBackend({
    read:async()=>({...baseRead,titleSource:"generated"}),
    generate:async()=>{
      calls++;
      return {finishReason:"stop",text:JSON.stringify({action:"rename",title:"🧩 邮箱注册｜验证码修复",reason:"主线明确"})};
    }
  });
  const result=await runNaming({backend,selection:{},apply:false,state:{lastFingerprint:"f0",lastTitle:"旧标题"}});
  assert.equal(result.status,"preview");
  assert.equal(calls,1);
});

test("runNaming：指纹未变且标题未变时 unchanged",async()=>{
  const {backend}=makeBackend({
    read:async()=>baseRead,
    generate:async()=>{throw new Error("不应调用");}
  });
  const result=await runNaming({backend,selection:{},state:{lastFingerprint:"f1",lastTitle:baseRead.title}});
  assert.equal(result.status,"unchanged");
});

test("runNaming：preview 不改名不落状态",async()=>{
  const rename={calls:[]};
  const {backend,saved}=makeBackend({
    read:async()=>baseRead,
    generate:async()=>({finishReason:"stop",text:JSON.stringify({action:"rename",title:"🧩 邮箱注册｜验证码修复",reason:"主线明确"})}),
    rename
  });
  const result=await runNaming({backend,selection:{},apply:false});
  assert.equal(result.status,"preview");
  assert.equal(rename.calls.length,0);
  assert.equal(saved.length,0);
});

test("runNaming：apply 完整改名并写 lastTitle",async()=>{
  const rename={calls:[]};
  let currentTitle=baseRead.title;
  const {backend,saved}=makeBackend({
    read:async()=>({...baseRead,title:currentTitle}),
    generate:async()=>({finishReason:"stop",text:JSON.stringify({action:"rename",title:"🧩 邮箱注册｜验证码修复",reason:"主线明确"})}),
    rename:async title=>{rename.calls.push(title);currentTitle=title;return {taskId:"s1",title};}
  });
  const result=await runNaming({backend,selection:{},apply:true});
  assert.equal(result.status,"renamed");
  assert.deepEqual(rename.calls,["🧩 邮箱注册｜验证码修复"]);
  const finalState=saved.at(-1);
  assert.equal(finalState.lastTitle,"🧩 邮箱注册｜验证码修复");
  assert.equal(finalState.pendingTitle,undefined);
});

test("runNaming：apply 后改名前标题漂移 → stale_result 且不落 lastTitle",async()=>{
  const rename={calls:[]};
  let readCount=0;
  const {backend,saved}=makeBackend({
    read:async()=>{
      readCount++;
      return readCount===1?baseRead:{...baseRead,fingerprint:"f2"};
    },
    generate:async()=>({finishReason:"stop",text:JSON.stringify({action:"rename",title:"🧩 邮箱注册｜验证码修复",reason:"主线明确"})}),
    rename
  });
  const result=await runNaming({backend,selection:{},apply:true});
  assert.equal(result.status,"stale_result");
  assert.equal(result.staleReason,"fingerprint");
  assert.equal(rename.calls.length,0);
  assert.ok(!saved.some(s=>s.lastTitle));
});

test("runNaming：keep 时写状态不改名",async()=>{
  const rename={calls:[]};
  const {backend}=makeBackend({
    read:async()=>baseRead,
    generate:async()=>({finishReason:"stop",text:JSON.stringify({action:"keep",title:"任意",reason:"主线未变"})}),
    rename
  });
  const result=await runNaming({backend,selection:{},apply:true});
  assert.equal(result.status,"kept");
  assert.equal(rename.calls.length,0);
});

test("runNaming：invalid_keep_title 触发一次带反馈的重试",async()=>{
  const rename={calls:[]};
  const contexts=[];
  let currentTitle="不合规的旧标题没有分隔符";
  const {backend}=makeBackend({
    read:async()=>({...baseRead,title:currentTitle}),
    generate:async context=>{
      contexts.push(context);
      if(!context.title_format_feedback)
        return {finishReason:"stop",text:JSON.stringify({action:"keep",title:"任意",reason:"x"})};
      return {finishReason:"stop",text:JSON.stringify({action:"rename",title:"🧩 邮箱注册｜验证码修复",reason:"已修正"})};
    },
    rename:async title=>{rename.calls.push(title);currentTitle=title;return {taskId:"s1",title};}
  });
  const result=await runNaming({backend,selection:{},apply:true});
  assert.equal(result.status,"renamed");
  assert.ok(contexts[1].title_format_feedback);
});

test("runNaming：invalid_keep_title 重试时用量按两轮并集合计",async()=>{
  // 首轮独有键也必须保留：只遍历次轮的键会静默丢统计
  const {backend}=makeBackend({
    read:async()=>({...baseRead,title:"不合规的旧标题没有分隔符"}),
    generate:async context=>context.title_format_feedback
      ? {finishReason:"stop",text:JSON.stringify({action:"rename",title:"🧩 邮箱注册｜验证码修复",reason:"已修正"}),usage:{outputTokens:7,secondOnly:2}}
      : {finishReason:"stop",text:JSON.stringify({action:"keep",title:"任意",reason:"x"}),usage:{outputTokens:5,firstOnly:3}}
  });
  const result=await runNaming({backend,selection:{}});
  assert.deepEqual(result.usage,{firstOnly:3,outputTokens:12,secondOnly:2});
});

test("runNaming：pendingTitle 对账——宿主已落库则确认并清理",async()=>{
  const {backend,saved}=makeBackend({
    read:async()=>({...baseRead,title:"🧩 邮箱注册｜验证码修复"}),
    generate:async()=>{throw new Error("不应调用");}
  });
  const result=await runNaming({backend,selection:{},apply:true,state:{pendingTitle:"🧩 邮箱注册｜验证码修复",pendingFingerprint:"f1",lastTitle:"旧"}});
  assert.ok(!saved.at(-1).pendingTitle);
  assert.equal(saved.at(-1).lastTitle,"🧩 邮箱注册｜验证码修复");
  assert.ok(result);
});

test("runNaming：requireFormat=false 时不强制格式",async()=>{
  const {backend}=makeBackend({
    read:async()=>baseRead,
    generate:async()=>({finishReason:"stop",text:JSON.stringify({action:"rename",title:"自由格式标题也可以",reason:"用户关闭格式"})})
  });
  const result=await runNaming({backend,selection:{},renameOptions:{requireFormat:false}});
  assert.equal(result.title,"自由格式标题也可以");
});
