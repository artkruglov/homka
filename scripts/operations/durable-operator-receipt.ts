/** Operator-owned private directory only. A returned promise means data AND name were synced.
 * A failed write leaves evidence for inspection, never an overwrite/retry permission.
 */
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
export async function writeOperatorReceipt(path:string,value:unknown):Promise<void>{
  const serialized=JSON.stringify(value,null,2)+'\n';
  const parent=dirname(resolve(path));
  if(await realpath(parent)!==parent)throw Error('AGENT_OPERATOR_PRIVATE_DIRECTORY_REQUIRED');
  const directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
    const info=await directory.stat();
    if((info.mode&0o777)!==0o700||info.uid!==process.getuid?.()){
      throw Error('AGENT_OPERATOR_PRIVATE_DIRECTORY_REQUIRED');
    }
    const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await file.writeFile(serialized);await file.sync();}finally{await file.close();}
    await directory.sync();
  }finally{await directory.close();}
}
