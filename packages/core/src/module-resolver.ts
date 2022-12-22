import { emberVirtualPackages, emberVirtualPeerDeps, packageName as getPackageName } from '@embroider/shared-internals';
import { dirname, resolve } from 'path';
import { PackageCache, Package, V2Package, explicitRelative } from '@embroider/shared-internals';
import { Memoize } from 'typescript-memoize';
import { compile } from './js-handlebars';

export interface Options {
  renamePackages: {
    [fromName: string]: string;
  };
  renameModules: {
    [fromName: string]: string;
  };
  extraImports: {
    absPath: string;
    target: string;
    runtimeName?: string;
  }[];
  externalsDir: string;
  activeAddons: {
    [packageName: string]: string;
  };
  relocatedFiles: { [relativePath: string]: string };
  resolvableExtensions: string[];
  appRoot: string;
}

export type Resolution =
  | { result: 'continue' }
  | { result: 'redirect-to'; specifier: string }
  | { result: 'external'; specifier: string };

export class Resolver {
  readonly originalFilename: string;

  constructor(readonly filename: string, private options: Options) {
    this.originalFilename = options.relocatedFiles[filename] || filename;
  }
  resolve(specifier: string): Resolution {
    if (specifier === '@embroider/macros') {
      // the macros package is always handled directly within babel (not
      // necessarily as a real resolvable package), so we should not mess with it.
      // It might not get compiled away until *after* our plugin has run, which is
      // why we need to know about it.
      return { result: 'continue' };
    }

    let maybeRenamed = this.handleRenaming(specifier);
    let resolution = this.handleExternal(maybeRenamed);
    if (resolution.result === 'continue' && maybeRenamed !== specifier) {
      return { result: 'redirect-to', specifier: maybeRenamed };
    }
    return resolution;
  }

  @Memoize()
  owningPackage(): Package | undefined {
    return PackageCache.shared('embroider-stage3', this.options.appRoot).ownerOfFile(this.originalFilename);
  }

  @Memoize()
  private relocatedIntoPackage(): V2Package | undefined {
    if (this.originalFilename !== this.filename) {
      let owning = PackageCache.shared('embroider-stage3', this.options.appRoot).ownerOfFile(this.filename);
      if (owning && !owning.isV2Ember()) {
        throw new Error(`bug: it should only be possible to get relocated into a v2 ember package here`);
      }
      return owning;
    }
  }

  private handleRenaming(specifier: string) {
    let packageName = getPackageName(specifier);
    if (!packageName) {
      return specifier;
    }

    for (let [candidate, replacement] of Object.entries(this.options.renameModules)) {
      if (candidate === specifier) {
        return replacement;
      }
      for (let extension of this.options.resolvableExtensions) {
        if (candidate === specifier + '/index' + extension) {
          return replacement;
        }
        if (candidate === specifier + extension) {
          return replacement;
        }
      }
    }

    if (this.options.renamePackages[packageName]) {
      return specifier.replace(packageName, this.options.renamePackages[packageName]);
    }

    let pkg = this.owningPackage();
    if (!pkg || !pkg.isV2Ember()) {
      return specifier;
    }

    if (pkg.meta['auto-upgraded'] && pkg.name === packageName) {
      // we found a self-import, resolve it for them. Only auto-upgraded
      // packages get this help, v2 packages are natively supposed to use
      // relative imports for their own modules, and we want to push them all to
      // do that correctly.
      return specifier.replace(packageName, pkg.root);
    }

    let relocatedIntoPkg = this.relocatedIntoPackage();
    if (relocatedIntoPkg && pkg.meta['auto-upgraded'] && relocatedIntoPkg.name === packageName) {
      // a file that was relocated into a package does a self-import of that
      // package's name. This can happen when an addon (like ember-cli-mirage)
      // emits files from its own treeForApp that contain imports of the app's own
      // fully qualified name.
      return specifier.replace(packageName, relocatedIntoPkg.root);
    }

    return specifier;
  }

  private handleExternal(specifier: string): Resolution {
    let pkg = this.owningPackage();
    if (!pkg || !pkg.isV2Ember()) {
      return { result: 'continue' };
    }

    let packageName = getPackageName(specifier);
    if (!packageName) {
      // This is a relative import. We don't automatically externalize those
      // because it's rare, and by keeping them static we give better errors. But
      // we do allow them to be explicitly externalized by the package author (or
      // a compat adapter). In the metadata, they would be listed in
      // package-relative form, so we need to convert this specifier to that.
      let absoluteSpecifier = resolve(dirname(this.filename), specifier);
      let packageRelativeSpecifier = explicitRelative(pkg.root, absoluteSpecifier);
      if (isExplicitlyExternal(packageRelativeSpecifier, pkg)) {
        let publicSpecifier = absoluteSpecifier.replace(pkg.root, pkg.name);
        return { result: 'external', specifier: publicSpecifier };
      } else {
        return { result: 'continue' };
      }
    }

    // absolute package imports can also be explicitly external based on their
    // full specifier name
    if (isExplicitlyExternal(specifier, pkg)) {
      return { result: 'external', specifier };
    }

    if (!pkg.meta['auto-upgraded'] && emberVirtualPeerDeps.has(packageName)) {
      // Native v2 addons are allowed to use the emberVirtualPeerDeps like
      // `@glimmer/component`. And like all v2 addons, it's important that they
      // see those dependencies after those dependencies have been converted to
      // v2.
      //
      // But unlike auto-upgraded addons, native v2 addons are not necessarily
      // copied out of their original place in node_modules. And from that
      // original place they might accidentally resolve the emberVirtualPeerDeps
      // that are present there in v1 format.
      //
      // So before we even check isResolvable, we adjust these imports to point at
      // the app's copies instead.
      if (emberVirtualPeerDeps.has(packageName)) {
        if (!this.options.activeAddons[packageName]) {
          throw new Error(
            `${pkg.name} is trying to import the app's ${packageName} package, but it seems to be missing`
          );
        }
        return {
          result: 'redirect-to',
          specifier: specifier.replace(packageName, this.options.activeAddons[packageName]),
        };
      }
    }

    let relocatedPkg = this.relocatedIntoPackage();
    if (relocatedPkg) {
      // this file has been moved into another package (presumably the app).

      // first try to resolve from the destination package
      if (isResolvable(packageName, relocatedPkg, this.options.appRoot)) {
        // self-imports are legal in the app tree, even for v2 packages.
        if (!pkg.meta['auto-upgraded'] && packageName !== pkg.name) {
          throw new Error(
            `${pkg.name} is trying to import ${packageName} from within its app tree. This is unsafe, because ${pkg.name} can't control which dependencies are resolvable from the app`
          );
        }
        return { result: 'continue' };
      } else {
        // second try to resolve from the source package
        let targetPkg = isResolvable(packageName, pkg, this.options.appRoot);
        if (targetPkg) {
          // self-imports are legal in the app tree, even for v2 packages.
          if (!pkg.meta['auto-upgraded'] && packageName !== pkg.name) {
            throw new Error(
              `${pkg.name} is trying to import ${packageName} from within its app tree. This is unsafe, because ${pkg.name} can't control which dependencies are resolvable from the app`
            );
          }
          // we found it, but we need to rewrite it because it's not really going to
          // resolve from where its sitting
          return {
            result: 'redirect-to',
            specifier: specifier.replace(packageName, targetPkg.root),
          };
        }
      }
    } else {
      if (isResolvable(packageName, pkg, this.options.appRoot)) {
        if (!pkg.meta['auto-upgraded'] && !reliablyResolvable(pkg, packageName)) {
          throw new Error(
            `${pkg.name} is trying to import from ${packageName} but that is not one of its explicit dependencies`
          );
        }
        return { result: 'continue' };
      }
    }

    // auto-upgraded packages can fall back to the set of known active addons
    //
    // v2 packages can fall back to the set of known active addons only to find
    // themselves (which is needed due to app tree merging)
    if ((pkg.meta['auto-upgraded'] || packageName === pkg.name) && this.options.activeAddons[packageName]) {
      return {
        result: 'redirect-to',
        specifier: specifier.replace(packageName, this.options.activeAddons[packageName]),
      };
    }

    if (pkg.meta['auto-upgraded']) {
      // auto-upgraded packages can fall back to attempting to find dependencies at
      // runtime. Native v2 packages can only get this behavior in the
      // isExplicitlyExternal case above because they need to explicitly ask for
      // externals.
      return { result: 'external', specifier };
    } else {
      // native v2 packages don't automatically externalize *everything* the way
      // auto-upgraded packages do, but they still externalize known and approved
      // ember virtual packages (like @ember/component)
      if (emberVirtualPackages.has(packageName)) {
        return { result: 'external', specifier };
      }
    }

    // this is falling through with the original specifier which was
    // non-resolvable, which will presumably cause a static build error in stage3.
    return { result: 'continue' };
  }
}

function isExplicitlyExternal(specifier: string, fromPkg: V2Package): boolean {
  return Boolean(fromPkg.isV2Addon() && fromPkg.meta['externals'] && fromPkg.meta['externals'].includes(specifier));
}

function isResolvable(packageName: string, fromPkg: V2Package, appRoot: string): false | Package {
  try {
    let dep = PackageCache.shared('embroider-stage3', appRoot).resolve(packageName, fromPkg);
    if (!dep.isEmberPackage() && fromPkg.meta['auto-upgraded'] && !fromPkg.hasDependency('ember-auto-import')) {
      // classic ember addons can only import non-ember dependencies if they
      // have ember-auto-import.
      //
      // whereas native v2 packages can always import any dependency
      return false;
    }
    return dep;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      throw err;
    }
    return false;
  }
}

// we don't want to allow things that resolve only by accident that are likely
// to break in other setups. For example: import your dependencies'
// dependencies, or importing your own name from within a monorepo (which will
// work because of the symlinking) without setting up "exports" (which makes
// your own name reliably resolvable)
function reliablyResolvable(pkg: V2Package, packageName: string) {
  if (pkg.hasDependency(packageName)) {
    return true;
  }

  if (pkg.name === packageName && pkg.packageJSON.exports) {
    return true;
  }

  if (emberVirtualPeerDeps.has(packageName)) {
    return true;
  }

  return false;
}

export const externalShim = compile(`
{{#if (eq moduleName "require")}}
const m = window.requirejs;
{{else}}
const m = window.require("{{{js-string-escape moduleName}}}");
{{/if}}
{{!-
  There are plenty of hand-written AMD defines floating around
  that lack this, and they will break when other build systems
  encounter them.

  As far as I can tell, Ember's loader was already treating this
  case as a module, so in theory we aren't breaking anything by
  marking it as such when other packagers come looking.

  todo: get review on this part.
-}}
if (m.default && !m.__esModule) {
  m.__esModule = true;
}
module.exports = m;
`) as (params: { moduleName: string }) => string;
