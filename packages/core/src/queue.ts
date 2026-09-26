import { PgBoss } from 'pg-boss';
import type { Tx } from '../../storage/src/index.js';

export const LEARNING_QUEUE='learning';
export async function createBoss(url=process.env.DATABASE_URL!, schedules=false) {
  const boss=new PgBoss({connectionString:url,schema:'queue',supervise:schedules,schedule:schedules});
  boss.on('error',()=>{});
  await boss.start();
  await boss.createQueue(LEARNING_QUEUE,{retryLimit:2,retryDelay:5,retryBackoff:true,expireInSeconds:210});
  await boss.createQueue('maintenance',{policy:'exclusive',retryLimit:1,expireInSeconds:50});
  await boss.createQueue('mail-send',{retryLimit:0,expireInSeconds:90});
  return boss;
}
export async function enqueue(boss: PgBoss, tx: Tx, runId: string) {
  await boss.send(LEARNING_QUEUE,{runId},{db:tx.bossDb,singletonKey:runId});
}
