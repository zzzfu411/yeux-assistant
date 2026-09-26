import { buildServer } from './server.js';
const {server}=await buildServer();
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await server.close();}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
const address=await server.listen({host:process.env.HOST||'127.0.0.1',port:Number(process.env.PORT||8765)});
console.log('学习助手已启动：'+address);
