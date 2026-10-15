import { createBackendGateway } from './handler.mjs';

// Only this trusted server capability can call the gateway. The service key
// stays in Supabase's injected environment and never reaches the application.
Deno.serve(createBackendGateway({ environment: (name: string) => Deno.env.get(name) }));
