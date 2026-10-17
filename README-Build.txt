LearnCpp native reader - minimal source repository

Build the current Windows x64 release entirely offline.

Requirements
  Windows, Windows PowerShell 5.1 or newer, and the MSVC x64 C++ tools
  with a Windows SDK (Visual Studio / Build Tools, Desktop development with C++).

Build and package
  From this directory, run:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build.ps1

  The script discovers MSVC automatically, compiles LearnCpp.exe with C++17
  and a static runtime, and creates:

    dist\LearnCpp-Native-CPP-Clean.zip

  Extract the ZIP and double-click LearnCpp.exe. The app opens
  http://127.0.0.1:8768/ and exits after the last reader tab closes.
  Reading progress and highlights live in data/state.json beside the EXE.

Repository contents
  LearnCpp.cpp   Complete native backend; the only C++ translation unit.
  third_party/  Pinned header-only dependencies and their licenses:
                  cpp-httplib v0.20.1, nlohmann/json v3.12.0.
  web/          Exact HTML/CSS/JavaScript/image snapshot from the current
                356-lesson native release, including its runtime README.
  build.ps1     Compile and package; no downloads or site crawling.
  .gitignore    Excludes all generated binaries, objects and ZIPs.

Every release starts with empty data. No reading state is read from build/
or a previously extracted copy. Build stages are kept in ignored build/.
The generated EXE and ZIP are rebuilt artifacts; toolchain versions and
timestamps may change their bytes. The bundled lesson and web resource
contents match the current release.

Upstream dependencies
  https://github.com/yhirose/cpp-httplib/tree/v0.20.1
  https://github.com/nlohmann/json/tree/v3.12.0

The included course content retains its original LearnCpp attribution.
The library licenses are included under third_party/ and in the app ZIP.
