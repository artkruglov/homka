import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,realpath,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeOperatorReceipt} from './durable-operator-receipt.ts';
const roots:string[]=[];
async function root(){const p=await realpath(await mkdtemp(join(tmpdir(),'operator-receipt-')));roots.push(p);return p;}
afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
it('stores the complete private snapshot and never replaces a previous receipt',async()=>{
  const p=join(await root(),'snapshot.json');const value={source:{id:'old'},references:[{price:415481}]};
  await writeOperatorReceipt(p,value);
  expect(JSON.parse(await readFile(p,'utf8'))).toEqual(value);
  expect((await stat(p)).mode&0o777).toBe(0o600);
  await expect(writeOperatorReceipt(p,{replaced:true})).rejects.toMatchObject({code:'EEXIST'});
  expect(JSON.parse(await readFile(p,'utf8'))).toEqual(value);
});
it('rejects a symbolic parent instead of writing through it',async()=>{
  const p=await root();const alias=join(p,'alias');await symlink(p,alias,'dir');
  await expect(writeOperatorReceipt(join(alias,'snapshot.json'),{})).rejects.toThrow('DIRECTORY_REQUIRED');
});
