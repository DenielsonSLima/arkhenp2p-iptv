import {createCollectorHandler} from './handler.mjs';
// Cron/pg_net use a dedicated secret; provider sources are decrypted only here.
Deno.serve(createCollectorHandler({environment:(name:string)=>Deno.env.get(name)}));
