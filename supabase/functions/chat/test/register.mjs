// node --import ./register.mjs: lets node run ../index.ts, which imports the SDK the Deno way
// ("npm:@anthropic-ai/sdk@1.3.0"), by resolving that specifier to the copy installed in this folder.
import { registerHooks } from 'node:module';

const SDK = 'npm:@anthropic-ai/sdk@1.3.0';
const HERE = new URL('./package.json', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SDK) return nextResolve('@anthropic-ai/sdk', { ...context, parentURL: HERE });
    return nextResolve(specifier, context);
  },
});
