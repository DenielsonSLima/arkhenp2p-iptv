import {createMarkerSyncHandler} from './handler.mjs';

// verify_jwt=false is paired with a dedicated constant-time secret check.
// The service role and provider keys exist only in Edge Function secrets.
Deno.serve(createMarkerSyncHandler({environment:(name:string)=>Deno.env.get(name)}));
