// node --import ./register.mjs: lets node run ../index.ts, which imports the SDK the Deno way
// ("npm:@anthropic-ai/sdk@1.3.0"). The tests never construct the real SDK client (a fake is injected), so the
// specifier resolves to the copy installed for the `chat` tests (run `npm install` in ../../chat/test once).
import { registerHooks } from 'node:module';

const SDK = 'npm:@anthropic-ai/sdk@1.3.0';
const CHAT_TESTS = new URL('../../chat/test/package.json', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SDK) return nextResolve('@anthropic-ai/sdk', { ...context, parentURL: CHAT_TESTS });
    return nextResolve(specifier, context);
  },
});
