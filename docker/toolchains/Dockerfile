FROM mcr.microsoft.com/dotnet/sdk:8.0 AS dotnet

FROM python:3.13-trixie

ENV DEBIAN_FRONTEND=noninteractive \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_ROOT=/opt/dotnet \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    NUGET_XMLDOC_MODE=skip \
    RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/dotnet:/opt/cargo/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        binutils \
        ca-certificates \
        clang \
        clang-format \
        clangd \
        curl \
        libicu-dev \
        libssl-dev \
        lld \
        pkg-config \
        zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dotnet /usr/share/dotnet /opt/dotnet
RUN ln -s /opt/dotnet/dotnet /usr/local/bin/dotnet \
    && dotnet --info

ARG PWSH_VERSION=7.6.6
ARG PWSH_SHA256=ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc
RUN curl --proto '=https' --tlsv1.2 -sSfL -o /tmp/powershell.tar.gz \
        "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-x64.tar.gz" \
    && echo "${PWSH_SHA256}  /tmp/powershell.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/microsoft/powershell/7 \
    && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 \
    && rm /tmp/powershell.tar.gz \
    && chmod +x /opt/microsoft/powershell/7/pwsh \
    && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh \
    && POWERSHELL_TELEMETRY_OPTOUT=1 pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable --component rustfmt,rust-analyzer

RUN python -m pip install --no-cache-dir black basedpyright

RUN useradd --create-home --shell /usr/sbin/nologin runner \
    && mkdir -p /workspace \
    && chown runner:runner /workspace

COPY run-code.sh /usr/local/bin/lang-tutor-run
RUN chmod 755 /usr/local/bin/lang-tutor-run

USER runner
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/lang-tutor-run"]
