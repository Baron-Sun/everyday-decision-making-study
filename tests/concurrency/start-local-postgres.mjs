/** Optional native PostgreSQL launcher. Install its packages outside the repo. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const entry=process.env.EMBEDDED_POSTGRES_PATH||'embedded-postgres';
const {default:EmbeddedPostgres}=await import(entry.startsWith('/')?pathToFileURL(entry).href:entry);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aita-concurrency-pg-'));
const port=Number(process.env.LOCAL_PG_PORT||55439);
const db=new EmbeddedPostgres({databaseDir:path.join(dir,'data'),user:'postgres',password:'local-benchmark-only',port,persistent:false,postgresFlags:['-c','listen_addresses=127.0.0.1','-c','max_connections=650','-c','shared_buffers=128MB','-c','work_mem=4MB','-c','log_min_messages=warning'],onLog:()=>{},onError:console.error});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await db.stop();process.exit(0)}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
await db.initialise();await db.start();
const c=db.getPgClient();await c.connect();
await c.query("create role anon login password 'local-benchmark-only';create role authenticated;create role service_role bypassrls;alter role anon set statement_timeout='3s'");
console.log(JSON.stringify((await c.query("select version(),current_setting('max_connections') as max_connections")).rows[0]));
await c.end();
console.log(`Local test server ready: postgresql://postgres:local-benchmark-only@127.0.0.1:${port}/postgres`);
console.log(`Temporary cluster: ${dir}; stop with Ctrl+C. Never use study credentials here.`);
await new Promise(()=>{});
