# Windows PowerShell 5.1+. Offline build; no package downloads.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$originalEnvironment = @{}

function Find-VcVars64 {
    $programRoots = @([Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86')) | Select-Object -Unique
    foreach ($base in $programRoots) {
        $vswhere = Join-Path $base 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path -LiteralPath $vswhere) {
            $candidates = @(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Auxiliary\Build\vcvars64.bat')
            foreach ($candidate in $candidates) {
                if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
            }
        }
    }
    foreach ($base in $programRoots) {
        $vsRoot = Join-Path $base 'Microsoft Visual Studio'
        if (Test-Path -LiteralPath $vsRoot) {
            $candidate = Get-ChildItem -LiteralPath $vsRoot -Filter 'vcvars64.bat' -File -Recurse -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($candidate) { return $candidate.FullName }
        }
    }
    throw 'MSVC x64 tools were not found. Install Visual Studio or Build Tools with Desktop development with C++, including a Windows SDK.'
}

Push-Location -LiteralPath $repo
try {
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue) -or $env:VSCMD_ARG_TGT_ARCH -ne 'x64') {
        $vcvars = Find-VcVars64
        # vcvars only supplies compiler environment variables to this process.
        $compilerEnvironment = & $env:ComSpec /d /s /c "call `"$vcvars`" >nul && set"
        if ($LASTEXITCODE -ne 0) { throw 'Failed to initialize the MSVC x64 environment.' }
        foreach ($line in $compilerEnvironment) {
            $pair = $line -split '=', 2
            if ($pair.Count -eq 2 -and $pair[0] -in @('PATH','INCLUDE','LIB','LIBPATH','VCToolsInstallDir','VSCMD_ARG_TGT_ARCH')) {
                $name = $pair[0]
                $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
                [Environment]::SetEnvironmentVariable($name, $pair[1], 'Process')
            }
        }
    }
    $compiler = (Get-Command cl.exe -ErrorAction Stop).Source
    $build = Join-Path $repo 'build'
    $dist = Join-Path $repo 'dist'
    New-Item -ItemType Directory -Path $build,$dist -Force | Out-Null
    $exe = Join-Path $build 'LearnCpp.exe'
    $object = Join-Path $build 'LearnCpp.obj'
    Write-Host 'Building LearnCpp.exe (C++17, Windows x64, static CRT)...'
    & $compiler /nologo /std:c++17 /EHsc /O2 /MT /utf-8 /W4 /DNDEBUG /DUNICODE /D_UNICODE 'LearnCpp.cpp' "/Fo$object" "/Fe$exe" /link /SUBSYSTEM:WINDOWS ws2_32.lib shell32.lib user32.lib
    if ($LASTEXITCODE -ne 0) { throw 'C++ compilation failed.' }

    # A fresh stage prevents existing reading records from entering a release.
    # Do not remove prior build folders or touch a previously extracted app.
    $stage = Join-Path $build ('package-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    foreach ($item in @('index.html','manifest.json','README.txt','assets','lessons')) {
        Copy-Item -LiteralPath (Join-Path $repo "web\$item") -Destination $stage -Recurse
    }
    Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'LearnCpp.exe')
    $licenses = Join-Path $stage 'licenses'
    New-Item -ItemType Directory -Path $licenses | Out-Null
    foreach ($name in @('httplib-LICENSE.txt','json-LICENSE.txt')) {
        Copy-Item -LiteralPath (Join-Path $repo "third_party\$name") -Destination $licenses
    }
    $data = Join-Path $stage 'data'
    New-Item -ItemType Directory -Path $data | Out-Null
    [IO.File]::WriteAllText((Join-Path $data 'state.json'), "{`"version`":2,`"lastLesson`":null,`"lessons`":{}}`n", [Text.UTF8Encoding]::new($false))
    $zip = Join-Path $dist 'LearnCpp-Native-CPP-Clean.zip'
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal -Force
    Write-Host ('Release: ' + $zip)
} finally {
    foreach ($name in $originalEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
    Pop-Location
}
