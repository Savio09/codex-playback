# Publishing Codex Playback

GitHub hosts the source. npm distributes the executable installed by
`npm install -g codex-playback` or run through `npx codex-playback`.

## First release

Use a normal terminal with Node.js 22 or newer. Work from the reviewed checkout
that has the source staged and this origin configured:

```sh
git remote get-url origin
```

It should be `https://github.com/Savio09/codex-playback.git`.

1. Check whether the npm name is already published:

   ```sh
   npm view codex-playback name version --registry=https://registry.npmjs.org/
   ```

   `E404` / `Not Found` means no public package was found. A network error does
   not establish name availability. If a package is returned, confirm that your
   npm account owns it before proceeding; otherwise choose an available name.

2. Validate the release:

   ```sh
   npm ci
   npm run check
   npm test
   npm run test:browser
   npm audit
   npm publish --dry-run
   ```

   Run the browser and local-server checks outside a restricted sandbox. Review
   the dry-run contents and resolve failing checks before publishing. The build
   runs automatically before packing or publishing.

3. Commit and push the reviewed source:

   ```sh
   git diff --cached --stat
   git diff --cached --check
   git commit -m "Initial release of Codex Playback"
   git push -u origin main
   ```

4. Create or sign into your [npm account](https://www.npmjs.com/signup), verify
   your email, and enable two-factor authentication. Then sign in from the CLI:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   ```

   Complete the browser authentication and any 2FA prompts locally.

5. Publish version `0.1.0`:

   ```sh
   npm publish --access public --registry=https://registry.npmjs.org/
   ```

   This is the step that makes the package public on npm. The package name and
   version must not have been published previously.

6. Verify the public installation:

   ```sh
   npm view codex-playback version --registry=https://registry.npmjs.org/
   npm install -g codex-playback
   codex-playback --version
   codex-playback
   ```

   The version should be `0.1.0`. Launch should open the local browser UI. You can
   also check the one-off command with `npx codex-playback --version`.

7. Tag the published source:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

## Later releases

Run the release checks, then use `npm version patch` for a backward-compatible
fix, or the appropriate minor/major version bump. Push the commit and tags, then
publish the new version. A previously published name/version cannot be reused.

## References

- [npm publishing requirements](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- [npm login](https://docs.npmjs.com/cli/v11/commands/npm-login/)
- [npm publish and version immutability](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
