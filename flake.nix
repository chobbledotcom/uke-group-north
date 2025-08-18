{
  inputs.nixpkgs.url = "nixpkgs";

  outputs =
    { self, nixpkgs }:
    {
      devShells.x86_64-linux.default =
        let
          pkgs = import nixpkgs { system = "x86_64-linux"; };
          npmScripts = pkgs.symlinkJoin {
            name = "npm-scripts";
            paths = map (cmd: pkgs.writeShellScriptBin cmd "npm run ${cmd}") [
              "serve"
              "build"
              "prepare-dev"
              "sync-files"
              "watch"
              "update-pages"
              "clean"
            ];
          };
        in
        pkgs.mkShell {
          buildInputs = [ pkgs.nodejs_23 npmScripts ];
          shellHook = ''
            cat <<EOF

            Available commands:
             serve        - Start development server
             build        - Build the project
             prepare-dev  - Prepare development environment
             sync-files   - Synchronize files
             watch        - Watch for changes
             update-pages - Update pages
             clean        - Clean build directory

            EOF
            git pull
          '';
        };
    };
}
