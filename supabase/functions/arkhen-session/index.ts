import {createSessionGateway} from './handler.mjs';

Deno.serve(createSessionGateway({environment: (name: string) => Deno.env.get(name)}));
