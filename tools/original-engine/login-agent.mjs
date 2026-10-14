import Java from 'frida-java-bridge';
import { createOriginalLogin } from './login.mjs';

rpc.exports = createOriginalLogin(Java);
