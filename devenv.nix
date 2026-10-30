{ pkgs, ... }:
let
  # One PATH command per package.json script so `devenv shell -- <command>` works.
  bunScripts = pkgs.symlinkJoin {
    name = "bun-scripts";
    paths = map (cmd: pkgs.writeShellScriptBin cmd "bun run ${cmd} -- \"$@\"") [
      "serve"
      "build"
      "prepare-dev"
      "sync-files"
      "watch"
      "update-pages"
      "update-scripts"
      "fetch-google-reviews"
      "clean"
      "test"
    ];
  };
in
{
  packages = with pkgs; [
    bun
    git
    vips
    stdenv.cc.cc.lib
    bunScripts
  ];

  # Bun honours NIX_LD on NixOS, letting dynamically linked npm platform
  # binaries (e.g. jscpd's) find their loader inside the devenv shell.
  env.NIX_LD = pkgs.lib.fileContents "${pkgs.stdenv.cc}/nix-support/dynamic-linker";
  env.NIX_LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc ];

  # bun auto-loads .env itself; stop devenv hinting about it
  dotenv.disableHint = true;

  enterShell = ''
    export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH"
  '';
}
