{
  description = "Agent-steward standalone decision CLI";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems f;
      perSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };
          lib = pkgs.lib;
          target = {
            x86_64-linux = { os = "linux"; cpu = "x64"; };
            aarch64-linux = { os = "linux"; cpu = "arm64"; };
            aarch64-darwin = { os = "darwin"; cpu = "arm64"; };
          }.${system};
          bunDeps = (import ./nix/bun-deps.nix) system;
          allGraphs = lib.genAttrs systems (import ./nix/bun-deps.nix);
          processPath = pkgs.runCommand "agent-steward-test-process-path" {
            nativeBuildInputs = [ pkgs.stdenv.cc ];
          } ''
            mkdir -p "$out/bin"
            cc -Wall -Wextra -Werror ${./tests/native-process-path.c} \
              ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin "-lproc"} \
              -o "$out/bin/process-path"
          '';
          psPath = if pkgs.stdenv.hostPlatform.isDarwin then "${pkgs.darwin.ps}/bin/ps" else "${pkgs.procps}/bin/ps";
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
          ./skills ./herdr-plugins ./examples ./README.md
        ];
      };
      package = pkgs.stdenv.mkDerivation {
        pname = "agent-steward";
        version = "0.1.0-alpha.6";
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
          export AGENT_STEWARD_BUN_OS='${target.os}'
          export AGENT_STEWARD_BUN_CPU='${target.cpu}'
          bun tests/bun-cache.ts
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
          export AGENT_STEWARD_BUN_CACHE_GRAPHS='${builtins.toJSON allGraphs}'
          bun run typecheck
          bun test tests/*.test.ts
          bun node_modules/oxlint/bin/oxlint src tests
          bun node_modules/oxfmt/bin/oxfmt --config=${./.oxfmtrc.json} --check src tests
          runHook postCheck
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p "$out/lib/agent-steward/dist/src" "$out/lib/agent-steward/node_modules" \
            "$out/bin" "$out/share/agent-steward/skills/agent-steward" \
            "$out/share/agent-steward/herdr-plugins/agent-steward-recover" \
            "$out/share/agent-steward/herdr-plugins/agent-steward-launcher"
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
          cp herdr-plugins/agent-steward-recover/herdr-plugin.toml "$out/share/agent-steward/herdr-plugins/agent-steward-recover/herdr-plugin.toml"
          cp herdr-plugins/agent-steward-recover/run.sh "$out/share/agent-steward/herdr-plugins/agent-steward-recover/run.sh"
          ln -s ../../../../bin/agent-steward-herdr-adapter \
            "$out/share/agent-steward/herdr-plugins/agent-steward-recover/agent-steward-herdr-adapter"
          cp herdr-plugins/agent-steward-launcher/herdr-plugin.toml "$out/share/agent-steward/herdr-plugins/agent-steward-launcher/herdr-plugin.toml"
          cp herdr-plugins/agent-steward-launcher/dispatch.sh "$out/share/agent-steward/herdr-plugins/agent-steward-launcher/dispatch.sh"
          makeWrapper "$out/lib/agent-steward/bun/bin/bun" "$out/bin/agent-steward" \
            --add-flags "$out/lib/agent-steward/dist/src/main.js" \
            --set AGENT_STEWARD_COMMAND "$out/bin/agent-steward" \
            --set AGENT_STEWARD_SHELL "${pkgs.runtimeShell}"
          makeWrapper "$out/lib/agent-steward/bun/bin/bun" "$out/bin/agent-steward-herdr-adapter" \
            --add-flags "$out/lib/agent-steward/dist/src/herdr-adapter/entry.js"
          runHook postInstall
        '';
      };
        in {
          devShell = pkgs.mkShell { packages = [ pkgs.bun pkgs.makeWrapper ]; };
        packages = { agent-steward = package; default = package; };
        app = { type = "app"; program = "${package}/bin/agent-steward"; };
        checks = {
          build = package;
          cache-graph = pkgs.runCommand "agent-steward-cache-graph" { } ''
            mkdir -p "$TMPDIR/graph"
            cp ${./bun.lock} "$TMPDIR/graph/bun.lock"
            mkdir -p "$TMPDIR/graph/tests"
            cp ${./tests/bun-cache.ts} "$TMPDIR/graph/tests/bun-cache.ts"
            cp ${./tests/bun-cache.test.ts} "$TMPDIR/graph/tests/bun-cache.test.ts"
            cd "$TMPDIR/graph"
            export AGENT_STEWARD_BUN_CACHE_GRAPHS='${builtins.toJSON allGraphs}'
            ${pkgs.bun}/bin/bun test tests/bun-cache.test.ts
            touch "$out"
          '';
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
            AGENT_STEWARD_FAKE_AGY="${./tests/fake-agy.ts}" \
            AGENT_STEWARD_SH="${pkgs.bash}/bin/bash" \
            AGENT_STEWARD_PS="${psPath}" \
            AGENT_STEWARD_PROCESS_PATH="${processPath}/bin/process-path" \
            AGENT_STEWARD_PROCESS_OBSERVER="${./tests/installed-process.ts}" \
            ${pkgs.bun}/bin/bun test ${./tests/installed.test.ts} ${./tests/herdr-plugin.test.ts} ${./tests/installed-delivery.test.ts} ${./tests/installed-agy.test.ts}
          touch "$out"
        '';
      };
    };
    in {
      packages = forAllSystems (system: (perSystem system).packages);
      apps = forAllSystems (system: { default = (perSystem system).app; });
      devShells = forAllSystems (system: { default = (perSystem system).devShell; });
      checks = forAllSystems (system: (perSystem system).checks);
    };
}
