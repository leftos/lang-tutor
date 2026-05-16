#!/usr/bin/env bash
set -euo pipefail

lang="${1:-}"
run_dir="/tmp/run"
mkdir -p "$run_dir"

case "$lang" in
  cpp)
    if [[ ! -f main.cpp ]]; then
      echo "main.cpp not found in sandbox workspace" >&2
      exit 64
    fi
    cp /workspace/main.cpp "$run_dir/main.cpp"
    cd "$run_dir"
    clang++ -std=c++23 -Wall -Wextra -pedantic -O0 -g main.cpp -o /tmp/main 2>&1
    /tmp/main 2>&1
    ;;
  dasm)
    if [[ ! -f main.cpp ]]; then
      echo "main.cpp not found in sandbox workspace" >&2
      exit 64
    fi
    cp /workspace/main.cpp "$run_dir/main.cpp"
    cd "$run_dir"
    read -r -a dasm_flags <<< "${DASM_COMPILER_FLAGS:--O0 -fno-omit-frame-pointer}"
    printf '[compiler]\nclang++ -std=c++23 -Wall -Wextra -pedantic -fno-pie %s -c main.cpp\n\n' "${dasm_flags[*]}"
    clang++ -std=c++23 -Wall -Wextra -pedantic -fno-pie "${dasm_flags[@]}" -c main.cpp -o /tmp/main.o 2>&1
    clang++ -no-pie /tmp/main.o -o /tmp/main 2>&1
    set +e
    program_output="$(/tmp/main 2>&1)"
    program_status=$?
    set -e
    printf '[program output]\n'
    if [[ -n "$program_output" ]]; then
      printf '%s\n' "$program_output"
    else
      printf '(no output)\n'
    fi
    if [[ "$program_status" -ne 0 ]]; then
      printf '[program exited with code %s]\n' "$program_status"
    fi
    printf '\n[disassembly: main.cpp object file, Intel syntax]\n'
    mapfile -t student_symbols < <(
      nm --defined-only /tmp/main.o \
        | awk '$2 ~ /^[TtWw]$/ { print $3 }' \
        | awk '
            $0 == "" { next }
            $0 ~ /^(_GLOBAL__|__|_init$|_fini$|_start$|frame_dummy$|deregister_tm_clones$|register_tm_clones$)/ { next }
            { print }
          '
    )
    if [[ "${#student_symbols[@]}" -eq 0 ]]; then
      printf '(no user-defined text symbols survived optimization; showing the object text section)\n'
      objdump -dr -Mintel -C --no-show-raw-insn -S /tmp/main.o | awk '/Disassembly of section \.text/{flag=1} flag {print; count++} count >= 220 {exit}'
    else
      for sym in "${student_symbols[@]}"; do
        printf -- '\n--- %s ---\n' "$(c++filt "$sym")"
        objdump -dr -Mintel -C --no-show-raw-insn -S --disassemble="$sym" /tmp/main.o | awk 'count < 140 { print; count++ }'
      done
    fi
    exit 0
    ;;
  rust)
    if [[ ! -f main.rs ]]; then
      echo "main.rs not found in sandbox workspace" >&2
      exit 64
    fi
    cp /workspace/main.rs "$run_dir/main.rs"
    cd "$run_dir"
    rustc --edition=2021 main.rs -o /tmp/main 2>&1
    /tmp/main 2>&1
    ;;
  python)
    if [[ ! -f main.py ]]; then
      echo "main.py not found in sandbox workspace" >&2
      exit 64
    fi
    cp /workspace/main.py "$run_dir/main.py"
    cd "$run_dir"
    python3 main.py 2>&1
    ;;
  csharp)
    if [[ ! -f main.cs ]]; then
      echo "main.cs not found in sandbox workspace" >&2
      exit 64
    fi
    export DOTNET_CLI_HOME=/tmp/dotnet-home
    export HOME=/tmp/home
    export NUGET_PACKAGES=/tmp/nuget-packages
    cp /workspace/main.cs "$run_dir/main.cs"
    cd "$run_dir"
    mkdir -p "$DOTNET_CLI_HOME" "$HOME" "$NUGET_PACKAGES" app
    cat > app/app.csproj <<'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>12.0</LangVersion>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
EOF
    cp main.cs app/Program.cs
    set +e
    dotnet_output="$(dotnet run --project app/app.csproj --configuration Release --verbosity quiet 2>&1)"
    dotnet_status=$?
    set -e
    printf '%s\n' "$dotnet_output" | sed '/^An issue was encountered verifying workloads\. For more information, run "dotnet workload update"\.$/d'
    exit "$dotnet_status"
    ;;
  *)
    echo "unknown language: $lang" >&2
    exit 64
    ;;
esac
