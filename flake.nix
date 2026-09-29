{
  description = "Agent-steward standalone decision CLI";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      package = pkgs.buildNpmPackage {
        pname = "agent-steward";
        version = "0.1.0";
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./package.json ./package-lock.json ./tsconfig.json ./src ./tests ./examples
            ./skills ./plugins ./README.md
          ];
        };
        nodejs = pkgs.nodejs_22;
        npmDepsHash = pkgs.lib.removeSuffix "\n" (builtins.readFile ./nix/npm-deps-hash);
        npmFlags = [ "--ignore-scripts" ];
        npmBuildScript = "build";
        nativeBuildInputs = [ pkgs.makeWrapper ];
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          export HOME="$TMPDIR/test-home"
          export XDG_CONFIG_HOME="$TMPDIR/test-xdg"
          mkdir -p "$HOME" "$XDG_CONFIG_HOME"
          unset TYPESAFE_API_KEY
          node --test tests/*.test.mjs
          runHook postCheck
        '';
        postInstall = ''
          mkdir -p "$out/share/agent-steward/skills/agent-steward" "$out/share/agent-steward/herdr-plugin"
          cp skills/agent-steward/SKILL.md "$out/share/agent-steward/skills/agent-steward/SKILL.md"
          cp plugins/agent-steward/herdr-plugin.toml plugins/agent-steward/run.sh "$out/share/agent-steward/herdr-plugin/"
          ln -s ../../../bin/agent-steward-herdr-adapter "$out/share/agent-steward/herdr-plugin/agent-steward-herdr-adapter"
          rm -f "$out/bin/agent-steward"
          makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/agent-steward" \
            --add-flags "$out/lib/node_modules/agent-steward/dist/src/main.js"
          makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/agent-steward-herdr-adapter" \
            --add-flags "$out/lib/node_modules/agent-steward/dist/src/herdr-adapter/entry.js"
        '';
      };
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.nodejs_22 pkgs.prefetch-npm-deps pkgs.makeWrapper ];
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
          nativeBuildInputs = [ pkgs.nodejs_22 pkgs.coreutils ];
        } ''
          mkdir -p "$TMPDIR/outside" "$TMPDIR/home" "$TMPDIR/xdg"
          cd "$TMPDIR/outside"
          env -i HOME="$TMPDIR/home" XDG_CONFIG_HOME="$TMPDIR/xdg" \
            AGENT_STEWARD_PACKAGE="${package}" \
            AGENT_STEWARD_SKILL_SOURCE="${./skills/agent-steward/SKILL.md}" \
            AGENT_STEWARD_PINNED_NODE="${pkgs.nodejs_22}/bin/node" \
            AGENT_STEWARD_DIRNAME="${pkgs.coreutils}/bin/dirname" \
            ${pkgs.nodejs_22}/bin/node --test ${./tests/installed.test.mjs} ${./tests/herdr-plugin.test.mjs}
          touch "$out"
        '';
      };
    };
}
