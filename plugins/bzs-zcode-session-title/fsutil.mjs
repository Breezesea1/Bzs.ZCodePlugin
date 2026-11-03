// 小型文件工具：JSON 统一走「临时文件 + 原子重命名」，并发读写不会看到半截内容。
import {randomUUID} from "node:crypto";
import {readFile,writeFile,rename} from "node:fs/promises";

export async function writeJsonAtomic(path,value) {
  const temporary=path+".tmp-"+randomUUID();
  await writeFile(temporary,JSON.stringify(value,null,2)+"\n","utf8");
  await rename(temporary,path);
}

// 读 JSON；不存在返回 null（调用方决定默认值），内容损坏则照常抛错。
export async function readJsonOptional(path) {
  try {return JSON.parse(await readFile(path,"utf8"));}
  catch(error) {if(error.code==="ENOENT")return null;throw error;}
}
