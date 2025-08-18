{
  inputs.nixpkgs.url = "nixpkgs";

  outputs =
    { self, nixpkgs }:
    {
      devShells.x86_64-linux.default =
        let
          pkgs = import nixpkgs { system = "x86_64-linux"; };
        in
        pkgs.mkShell {
          buildInputs = [ pkgs.nodejs_23 ];
          shellHook = ''
            cat <<EOF

            Available npm commands:
             - npm run serve  - Start development server
             - npm run clean  - Clean build directory

            EOF
            git pull
          '';
        };
    };
}
