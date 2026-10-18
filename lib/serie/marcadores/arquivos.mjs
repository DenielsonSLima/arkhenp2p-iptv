import {randomUUID} from 'node:crypto';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function atomicJSON(filename,value,{privateFile=false}={}){
  await mkdir(resolve(filename,'..'),{recursive:true,...(privateFile?{mode:0o700}:{})});
  const temporary=filename+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value,null,privateFile?0:2)+'\n',{mode:privateFile?0o600:0o644});await rename(temporary,filename);
}

