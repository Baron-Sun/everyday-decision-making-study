import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const driver=process.env.PG_DRIVER_PATH||'pg';
const {default:pg}=await import(driver.startsWith('/')?pathToFileURL(driver).href:driver);
const base=new URL(process.env.LOCAL_PG_URL||'postgresql://postgres:local-benchmark-only@127.0.0.1:55439/postgres');
assert(['127.0.0.1','localhost','[::1]'].includes(base.hostname),'Local database only');
const baseline=await fs.readFile(process.env.BASELINE_SETUP_SQL||'/private/tmp/aita-pg-runtime/baseline_setup.sql','utf8');
const current=await fs.readFile('supabase_advice_transfer_setup.sql','utf8');
const full=await fs.readFile('supabase_advice_transfer_concurrency_migration.sql','utf8');
const checked=await fs.readFile('supabase_advice_transfer_concurrency_upgrade_checked.sql','utf8');
const historicalFiles=['supabase_advice_transfer_v4_gist_migration.sql','supabase_advice_transfer_same_post_migration.sql','supabase_advice_transfer_opinion_difficulty_migration.sql','supabase_advice_transfer_leading_label_only_patch.sql'];
const historicalSql=await Promise.all(historicalFiles.map(f=>fs.readFile(f,'utf8')));
const seed=await fs.readFile('supabase_advice_transfer_seed.sql','utf8');
const hashes=JSON.parse(await fs.readFile('tests/concurrency/function-hashes.json','utf8'));
const admin=new pg.Client({connectionString:base.href});await admin.connect();
const clients=[];const results=[];
async function db(suffix,sql=baseline){
 const name=`aita_load_validate_${suffix}`;await admin.query(`drop database if exists "${name}" with (force)`);await admin.query(`create database "${name}"`);
 const url=new URL(base);url.pathname=`/${name}`;const c=new pg.Client({connectionString:url.href});await c.connect();clients.push(c);
 await c.query('create schema extensions;create extension pgcrypto with schema extensions;set search_path=public,extensions');await c.query(sql);await c.query(seed);return c;
}
async function snapshot(c){return (await c.query("select p.oid::regprocedure::text as signature,md5(p.prosrc) as body_md5,p.proconfig,p.proacl::text as grants,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%advice_transfer%' order by signature")).rows;}
try{
 const flavors={};
 const baselineClient=await db('baseline');
 for(const file of ['tests/advice-transfer-integration.sql','tests/advice-transfer-v4-integration.sql','tests/advice-transfer-same-post-integration.sql','tests/advice-transfer-leading-label-integration.sql']){
   await baselineClient.query(await fs.readFile(file,'utf8'));results.push({flavor:'baseline',test:file,ok:true});console.log(`baseline: PASS ${file}`);
 }

 for(const [name,sql] of [['full',full],['checked',checked],['fresh',null]]){
   const c=await db(name,sql?baseline:current);const before=await snapshot(c);
   const settingsBefore=(await c.query('select jsonb_object_agg(setting_key,setting_value) as settings from advice_transfer_settings')).rows[0];
   if(sql){await c.query(sql);const once=await snapshot(c);await c.query(sql);assert.deepEqual(await snapshot(c),once,`${name} is idempotent`);}
   const after=await snapshot(c);flavors[name]=after;
   if(sql)for(const f of before){const changed=after.find(a=>a.signature===f.signature);assert.equal(changed.grants,f.grants,`${name}: grants preserved for ${f.signature}`);}
   assert.deepEqual((await c.query('select jsonb_object_agg(setting_key,setting_value) as settings from advice_transfer_settings')).rows[0],settingsBefore);
   for(const hash of hashes){const f=after.find(a=>a.signature===hash.function);assert(f,hash.function);assert.equal(f.body_md5,hash.after,`${name}: ${hash.function} hash`);assert(f.proconfig.includes('lock_timeout=250ms'),`${name}: bounded lock wait ${hash.function}`);}
   for(const file of ['tests/advice-transfer-integration.sql','tests/advice-transfer-v4-integration.sql','tests/advice-transfer-same-post-integration.sql','tests/advice-transfer-leading-label-integration.sql']){
     await c.query(await fs.readFile(file,'utf8'));results.push({flavor:name,test:file,ok:true});console.log(`${name}: PASS ${file}`);
   }
   assert.equal((await c.query('select count(*)::int as n from advice_transfer_assignments')).rows[0].n,0,'SQL integration tests roll back');
   results.push({flavor:name,idempotent:true,allFunctionHashesCorrect:true,grantsPreserved:true,recruitmentSettingsPreserved:true});
 }
 assert.deepEqual(flavors.full,flavors.checked,'checked migration matches full source/config/grants');
 assert.deepEqual(flavors.full,flavors.fresh,'fresh setup matches full source/config/grants');
 results.push({allThreeFlavorsExactlyEquivalent:true});
 for(const [name,sql] of [['live_full',full],['live_checked',checked]]){
   const c=await db(name);
   for(const oldSql of historicalSql)await c.query(oldSql);
   await c.query(await fs.readFile('tests/concurrency/historical-snapshot-prepare.sql','utf8'));
   const before=await snapshot(c);
   await c.query(sql);const once=await snapshot(c);await c.query(sql);const after=await snapshot(c);
   assert.deepEqual(after,once,`${name} idempotence`);
   for(const hash of hashes){assert.equal(after.find(f=>f.signature===hash.function)?.body_md5,hash.after,`${name} canonical source ${hash.function}`);}
   for(const f of before){assert.equal(after.find(a=>a.signature===f.signature).grants,f.grants,`${name} ACL preserved`);}
   flavors[name]=after;
   for(const signature of hashes.map(h=>h.function))assert.deepEqual(after.find(f=>f.signature===signature),flavors.full.find(f=>f.signature===signature),`${name} patched function source/config/ACL equivalence`);
   await c.query(await fs.readFile('tests/concurrency/historical-snapshot-verify.sql','utf8'));
   results.push({flavor:name,actualHistoricalMigrationChain:historicalFiles,idempotent:true,allFunctionHashesCorrect:true,grantsPreserved:true,historicalSnapshotsPreserved:true,historicalFinalSubmissionIdempotent:true,partialAndWrongPresentAuditRejected:true});
   console.log(`${name}: PASS historical locked snapshots across actual migration`);
 }
 assert.deepEqual(flavors.live_full,flavors.live_checked,'Live full and checked upgrades preserve identical helper functions and ACLs');
 results.push({liveFullAndCheckedExactlyEquivalent:true});
 const broken=await db('failclosed');
 const target=(await broken.query("select prosrc,pg_get_functiondef(oid) as definition from pg_proc where oid='public.heartbeat_advice_transfer_assignment(text,text)'::regprocedure")).rows[0];
 await broken.query(target.definition.replace(target.prosrc,target.prosrc+'\n-- unexpected local revision\n'));
 const beforeBad=await snapshot(broken);let error;
 try{await broken.query(checked)}catch(e){error=e;await broken.query('rollback')}
 assert(error?.message?.includes('Unexpected installed definition'),'unexpected definition must reject checked deployment');
 assert.deepEqual(await snapshot(broken),beforeBad,'failed deployment rolls back every prior function/config change');
 assert.equal((await broken.query("select to_regclass('public.advice_transfer_claimed_lease_idx') as idx")).rows[0].idx,null,'failed deployment rolls back index creation');
 results.push({unexpectedSourceFailsClosedAtomically:true,error:error.message});
 console.log(JSON.stringify(results,null,2));
 await fs.writeFile('/private/tmp/aita-pg-runtime/migration-validation.json',JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n');
}finally{await Promise.allSettled(clients.map(c=>c.end()));await admin.end()}
