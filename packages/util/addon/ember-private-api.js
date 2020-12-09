import { macroCondition, dependencySatisfies } from '@embroider/macros';

/* global Ember */
const { isCurriedComponentDefinition, CurriedComponentDefinition, curry } = Ember.__loader.require('@glimmer/runtime');
export { isCurriedComponentDefinition };

function runtimeResolver(owner) {
  let resolver = owner.lookup('renderer:-dom')._runtimeResolver;
  if (resolver) {
    return resolver;
  }

  let entry = Object.entries(owner.__container__.cache).find(e => e[0].startsWith('template-compiler:main-'));
  if (entry) {
    return entry[1].resolver.resolver;
  }

  throw new Error(`@embroider/util couldn't locate the runtime resolver on this ember version`);
}

function constants(owner) {
  return owner.lookup('renderer:-dom')?._context?.constants;
}

export function lookupCurriedComponentDefinition(name, owner) {
  let resolver = runtimeResolver(owner);
  if (typeof resolver.lookupComponentHandle === 'function') {
    let handle = resolver.lookupComponentHandle(name, contextForLookup(owner));
    if (handle != null) {
      return new CurriedComponentDefinition(resolver.resolve(handle), null);
    }
  }

  let resolvedDefinition = resolver.lookupComponent(name, owner);
  if (!resolvedDefinition) {
    throw new Error(`Attempted to resolve \`${name}\` via ensureSafeComponent, but nothing was found.`);
  }
  return curry(constants(owner).resolvedComponent(resolvedDefinition, name), { named: {}, positional: [] });
}

function contextForLookup(owner) {
  if (macroCondition(dependencySatisfies('ember-source', '>=3.24.0-canary || >=3.24.0-beta'))) {
    return owner;
  } else {
    return { owner };
  }
}
