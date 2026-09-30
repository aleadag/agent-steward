{
  description = "Agent-steward standalone decision CLI";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = pkgs.lib;
      bunDeps = [
        { name = "@oxfmt/binding-linux-x64-gnu"; version = "0.71.0"; hash = "sha512-5/Z6pUewQpknXqC4/ykK6Zc6RiteAnPem1Ci7K1RZLVF6w6MMjwHjR4vsjijW4Czidgv7HKeVglGjElADliT9w=="; }
        { name = "@oxfmt/binding-linux-x64-musl"; version = "0.71.0"; hash = "sha512-uVdG2N/4GEbOeljpQ+xv+NeEwJWJGj0WaxSiSYnoiqIYy3RWrWd3rGUmxWXP1A8+ferNvvwFoDAtvgsDUvBuSw=="; }
        { name = "@oxlint/binding-linux-x64-gnu"; version = "1.86.0"; hash = "sha512-C1WjukSyMnr66b+w1/tV8RFVv6d9v0MzDf4p9IxVXknqgmTHBgZh1pccN1eHzFr0b9Tbb3OXoPsAAdAuHAQfeA=="; }
        { name = "@oxlint/binding-linux-x64-musl"; version = "1.86.0"; hash = "sha512-ap6KLmvC38c6MdYzsIh25cXQupqYvjd37tMNftzrX1DCtkX1Gcf2B+S2B17dD4lKa5c5gJog7DQJyDo82PBKyw=="; }
        { name = "@types/bun"; version = "1.4.2"; hash = "sha512-GimotNn7+ZV0uVArItBbriZsR1oNf0+WTzPkdcFrzShI7k2norL0uzEaJT8T33dWr7O/c9ZDuAFQrctKCi72oQ=="; }
        { name = "@types/node"; version = "22.18.6"; hash = "sha512-r8uszLPpeIWbNKtvWRt/DbVi5zbqZyj1PTmhRMqBMvDnaz1QpmSKujUtJLrqGZeoM8v72MfYggDceY4K1itzWQ=="; }
        { name = "bun-types"; version = "1.4.2"; hash = "sha512-bxV1FgK7yBIzjRe5zBozIM4Bem11ZJcCXSrjWRG3YWLt8yFDePu4cLjpebO8OvPeIE9trbyPF4fuj3Cia4Fj3w=="; }
        { name = "oxfmt"; version = "0.71.0"; hash = "sha512-lUPUl0d/+Io5pDrsPXWs6rB4N/bpB78oj9CTDpnbulfDz+0r3XXcHPlQ7kRPJ2GjIT4nX+/mcqunOeP9BvsEtg=="; }
        { name = "oxlint"; version = "1.86.0"; hash = "sha512-og0lhgvZfgGF//gOOmZXvtr+GmBbAGEnbEhv/QUg7UW2Wi4wHMnJbnMD+zuHgPdJxdklfgpPupdlAaAySyxrZg=="; }
        { name = "tinypool"; version = "2.2.0"; hash = "sha512-jBrmx4lYmaC9k/mgPbylxs7kBUxHtD8256up+HjLaDFfXScKJQyil+SWXSvhAtT7XHo+yTVlpB81PGmHP8oLSQ=="; }
        { name = "typescript"; version = "5.9.3"; hash = "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw=="; }
        { name = "undici-types"; version = "6.21.0"; hash = "sha512-iwDZqg0QAGrg9Rav5H4n0M64c3mkR59cJ6wQp+7C4nI0gsmExaedaYLNO44eT4AtBBwjbTiGPMlt2Md0T9H9JQ=="; }
        { name = "zod"; version = "4.1.12"; hash = "sha512-JInaHOamG8pt5+Ey8kGmdcAcg3OL9reK8ltczgHTAwNhMys/6ThXHityHxVV2p3fkw/c+MAvBHFVYHFZDmjMCQ=="; }
      ];
      fetchedBunDeps = map (dep:
        let
          parts = lib.splitString "/" dep.name;
          leaf = lib.last parts;
          cachePath = if lib.hasPrefix "@" dep.name
            then "${builtins.head parts}/${builtins.elemAt parts 1}@${dep.version}@@@1"
            else "${dep.name}@${dep.version}@@@1";
        in {
          inherit cachePath;
          archive = pkgs.fetchurl {
            url = "https://registry.npmjs.org/${dep.name}/-/${leaf}-${dep.version}.tgz";
            inherit (dep) hash;
            name = "bun-${builtins.replaceStrings [ "/" "@" ] [ "-" "" ] dep.name}-${dep.version}.tgz";
          };
        }
      ) bunDeps;
      bunCache = pkgs.runCommand "agent-steward-bun-cache" {
        nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ];
      } ''
        set -euo pipefail
        mkdir -p "$out"
        ${lib.concatMapStringsSep "\n" (dep: ''
          mkdir -p "$out/${dep.cachePath}"
          tar -xzf "${dep.archive}" -C "$out/${dep.cachePath}" --strip-components=1
        '') fetchedBunDeps}
      '';
      bunCacheLock = builtins.toJSON (map (dep: {
        inherit (dep) name version hash;
      }) bunDeps);
      source = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json ./bun.lock ./tsconfig.json ./tsconfig.tests.json ./src ./tests
          ./skills ./plugins ./examples ./README.md
        ];
      };
      package = pkgs.stdenv.mkDerivation {
        pname = "agent-steward";
        version = "0.1.0-alpha.1";
        src = source;
        nativeBuildInputs = [ pkgs.bun pkgs.bash pkgs.coreutils pkgs.makeWrapper ];
        doCheck = true;
        dontConfigure = true;
        buildPhase = ''
          runHook preBuild
          work="$TMPDIR/project"
          cache="$TMPDIR/bun-cache"
          mkdir -p "$work" "$cache" "$TMPDIR/home" "$TMPDIR/xdg-cache" "$TMPDIR/test-bin"
          cp -R "$src"/. "$work/"
          chmod -R u+rwX "$work"
          cp -R ${bunCache}/. "$cache/"
          chmod -R u+rwX "$cache"
          ln -s ${pkgs.bash}/bin/bash "$TMPDIR/test-bin/sh"
          export HOME="$TMPDIR/home"
          export XDG_CACHE_HOME="$TMPDIR/xdg-cache"
          export PATH="$TMPDIR/test-bin:$PATH"
          cd "$work"
          export AGENT_STEWARD_BUN_CACHE_LOCK='${bunCacheLock}'
          bun -e '
            const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text());
            const line = (name, version, hash) => [name, version, hash].join(String.fromCharCode(9));
            const expected = JSON.parse(process.env.AGENT_STEWARD_BUN_CACHE_LOCK)
              .map((dep) => line(dep.name, dep.version, dep.hash))
              .sort();
            const actual = Object.entries(lock.packages)
              .filter(([, [, , metadata]]) =>
                (!metadata?.os || metadata.os === "linux") && (!metadata?.cpu || metadata.cpu === "x64"),
              )
              .map(([name, [id, , , hash]]) => line(name, id.slice(name.length + 1), hash))
              .sort();
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              throw new Error("Nix Bun cache hashes do not exactly match the linux x64 bun.lock graph");
            }
          '
          bun --version
          bun install --offline --frozen-lockfile --ignore-scripts --cache-dir="$cache"
          bun run build
          runHook postBuild
        '';
        checkPhase = ''
          runHook preCheck
          export HOME="$TMPDIR/home"
          export XDG_CACHE_HOME="$TMPDIR/xdg-cache"
          export PATH="$TMPDIR/test-bin:$PATH"
          cd "$TMPDIR/project"
          bun run typecheck
          bun test tests/*.test.ts
          runHook postCheck
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p "$out/lib/agent-steward/dist/src" "$out/lib/agent-steward/node_modules" \
            "$out/bin" "$out/share/agent-steward/skills/agent-steward" "$out/share/agent-steward/herdr-plugin"
          cp -R "$TMPDIR/project/dist/src/." "$out/lib/agent-steward/dist/src/"
          mkdir -p "$out/lib/agent-steward/node_modules/zod"
          (
            cd "$TMPDIR/project/node_modules/zod"
            find . -type f \( -name '*.js' -o -name package.json -o -name LICENSE \) -print |
              while IFS= read -r file; do
                install -D "$TMPDIR/project/node_modules/zod/$file" \
                  "$out/lib/agent-steward/node_modules/zod/$file"
              done
          )
          ln -s ${pkgs.bun} "$out/lib/agent-steward/bun"
          cp skills/agent-steward/SKILL.md "$out/share/agent-steward/skills/agent-steward/SKILL.md"
          cp plugins/agent-steward/herdr-plugin.toml "$out/share/agent-steward/herdr-plugin/herdr-plugin.toml"
          cp plugins/agent-steward/run.sh "$out/share/agent-steward/herdr-plugin/run.sh"
          ln -s ../../../bin/agent-steward-herdr-adapter \
            "$out/share/agent-steward/herdr-plugin/agent-steward-herdr-adapter"
          makeWrapper "$out/lib/agent-steward/bun/bin/bun" "$out/bin/agent-steward" \
            --add-flags "$out/lib/agent-steward/dist/src/main.js"
          makeWrapper "$out/lib/agent-steward/bun/bin/bun" "$out/bin/agent-steward-herdr-adapter" \
            --add-flags "$out/lib/agent-steward/dist/src/herdr-adapter/entry.js"
          runHook postInstall
        '';
      };
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.bun pkgs.makeWrapper ];
      };
      packages.${system} = {
        agent-steward = package;
        default = package;
      };
      apps.${system}.default = {
        type = "app";
        program = "${package}/bin/agent-steward";
      };
      checks.${system} = {
        build = package;
        installed = pkgs.runCommand "agent-steward-installed-check" {
          nativeBuildInputs = [ pkgs.bun pkgs.coreutils ];
        } ''
          mkdir -p "$TMPDIR/outside" "$TMPDIR/home" "$TMPDIR/xdg"
          cd "$TMPDIR/outside"
          ${pkgs.coreutils}/bin/env -i HOME="$TMPDIR/home" XDG_CONFIG_HOME="$TMPDIR/xdg" PATH="" \
            AGENT_STEWARD_PACKAGE="${package}" \
            AGENT_STEWARD_SKILL_SOURCE="${./skills/agent-steward/SKILL.md}" \
            AGENT_STEWARD_DIRNAME="${pkgs.coreutils}/bin/dirname" \
            AGENT_STEWARD_MKFIFO="${pkgs.coreutils}/bin/mkfifo" \
            AGENT_STEWARD_FIFO_WRITER="${./tests/fifo-writer.ts}" \
            ${pkgs.bun}/bin/bun test ${./tests/installed.test.ts} ${./tests/herdr-plugin.test.ts}
          touch "$out"
        '';
      };
    };
}
