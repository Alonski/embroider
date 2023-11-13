import { posix } from 'path';
import minimatch from 'minimatch';
import { exports as resolveExports } from 'resolve.exports';

type Exports = string | string[] | { [key: string]: Exports };

/**
 * An util to find a string value in a nested JSON-like structure.
 *
 * Receives an object (a netsted JSON-like structure) and a matcher callback
 * that is tested against each string value.
 *
 * When a value is found, returns an object containing a `value` and a `key`.
 * The key is one of the parent keys of the found value — the one that starts
 * with `.`.
 *
 * When a value is not found, returns `undefined`.
 */
export function _findPathRecursively(
  exportsObj: Exports,
  matcher: (path: string) => boolean,
  key = '.'
): { key: string; value: Exports } | undefined {
  if (typeof exportsObj === 'string') {
    return matcher(exportsObj) ? { key, value: exportsObj } : undefined;
  }

  if (Array.isArray(exportsObj)) {
    const value = exportsObj.find(path => matcher(path));

    if (value) {
      return { key, value };
    } else {
      return undefined;
    }
  }

  if (typeof exportsObj === 'object') {
    let result: { key: string; value: Exports } | undefined = undefined;

    for (const candidateKey in exportsObj) {
      if (!exportsObj.hasOwnProperty(candidateKey)) {
        return;
      }

      const candidate = _findPathRecursively(exportsObj[candidateKey], matcher, key);

      if (candidate) {
        result = {
          key: candidateKey,
          value: candidate.value,
        };

        break;
      }
    }

    if (result) {
      if (result.key.startsWith('./')) {
        if (key !== '.') {
          throw new Error(`exportsObj contains doubly nested path keys: "${key}" and "${result.key}"`);
        }

        return { key: result.key, value: result.value };
      } else {
        return { key, value: result.value };
      }
    } else {
      return undefined;
    }
  }

  throw new Error(`Unexpected type of obj: ${typeof exportsObj}`);
}

export default function reversePackageExports(
  { exports: exportsObj, name }: { exports?: Exports; name: string },
  relativePath: string
): string {
  // // TODO add an actual matching system and don't just look for the default
  // if (packageJSON.exports?.['./*'] === './dist/*.js') {
  //   return posix.join(packageJSON.name, relativePath.replace(/^.\/dist\//, `./`).replace(/\.js$/, ''));
  // }

  if (!exportsObj) {
    return posix.join(name, relativePath);
  }

  const maybeKeyValuePair = _findPathRecursively(exportsObj, candidate => {
    // miminatch does not treat directories as full of content without glob
    if (candidate.endsWith('/')) {
      candidate += '**';
    }

    return minimatch(relativePath, candidate);
  });

  if (!maybeKeyValuePair) {
    // TODO figure out what the result should be if it doesn't match anything in exports
    return posix.join(name, relativePath);
  }

  const { key, value } = maybeKeyValuePair;

  if (typeof value !== 'string') {
    throw new Error('Expected value to be a string');
  }

  const maybeResolvedPaths = resolveExports({ name, exports: { [value]: key } }, relativePath);

  if (!maybeResolvedPaths) {
    throw new Error('Expected path to be found at this point');
  }

  const [resolvedPath] = maybeResolvedPaths;

  return resolvedPath.replace(/^./, name);
}
