#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Configures Windows Firewall for BrandLens. Opens only what is needed.

.DESCRIPTION
    THE RECOMMENDED TOPOLOGY

        internet --> :443 Caddy --+--> 127.0.0.1:3000  web console
                     :80  Caddy   +--> 127.0.0.1:4000  API
                                  \--> 127.0.0.1:8000  engine (never proxied)
                                       127.0.0.1:5432  PostgreSQL

    Only Caddy listens publicly. The four application ports stay bound to
    loopback and are never added to the firewall at all, which is stronger
    than a firewall rule: a service that is not listening on 0.0.0.0 cannot be
    reached even if a rule is later added by mistake.

    Binding to loopback is a configuration choice, not a firewall one:

        .env                  API_HOST=127.0.0.1
        ecosystem.config.cjs  ENGINE_HOST=127.0.0.1  (already the default)
        postgresql.conf       listen_addresses = 'localhost'

    Modes:

      Proxy (default)   open 80 + 443 for Caddy. Nothing else.
      Direct            open the API and web ports directly. Use only when
                        something else already terminates TLS in front.
      LocalOnly         open nothing; assert that the services are loopback-
                        bound and report anything that is not.

    Every rule is named `BrandLens - <what>` and grouped as `BrandLens`, so
    the whole set can be listed or removed in one command.

.PARAMETER Mode
    Proxy | Direct | LocalOnly.  Default: Proxy.

.PARAMETER RemoteAddress
    Restrict the rules to a source range, e.g. '10.0.0.0/8' or 'LocalSubnet'.
    Default: Any. Setting this is the single highest-value hardening step for
    an internal deployment.

.PARAMETER AllowPostgres
    Also open 5432. Only for a separate application host -- never expose
    PostgreSQL to the internet.

.PARAMETER FirewallProfile
    Firewall profiles the rules apply to: Domain, Private, Public, or Any.
    Default: Domain,Private -- deliberately NOT Public.

.PARAMETER Remove
    Delete every BrandLens firewall rule and exit.

.PARAMETER List
    Show the current BrandLens rules and exit.

.EXAMPLE
    .\firewall.ps1
    Open 80/443 for Caddy on the Domain and Private profiles.

.EXAMPLE
    .\firewall.ps1 -Mode Direct -RemoteAddress 10.20.0.0/16
    No reverse proxy; expose the API and console to one internal subnet.

.EXAMPLE
    .\firewall.ps1 -Mode LocalOnly
    Audit binding without changing the firewall.

.EXAMPLE
    .\firewall.ps1 -Remove -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateSet('Proxy', 'Direct', 'LocalOnly')]
    [string]$Mode = 'Proxy',
    [string[]]$RemoteAddress = @('Any'),
    [switch]$AllowPostgres,
    [ValidateSet('Domain', 'Private', 'Public', 'Any')]
    [string[]]$FirewallProfile = @('Domain', 'Private'),
    [switch]$Remove,
    [switch]$List
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner 'BrandLens - firewall'

$GROUP = 'BrandLens'

if (-not (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue)) {
    Write-Fail 'the NetSecurity module is unavailable on this host'
    Write-Hint @(
        'On Server Core, use netsh instead:',
        '  netsh advfirewall firewall add rule name="BrandLens - HTTPS" ^',
        '    dir=in action=allow protocol=TCP localport=443'
    )
    exit 1
}

# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------
if ($List) {
    $rules = @(Get-NetFirewallRule -Group $GROUP -ErrorAction SilentlyContinue)
    if ($rules.Count -eq 0) {
        Write-Info 'no BrandLens firewall rules are present'
        exit 0
    }
    $rules | ForEach-Object {
        $filter = $_ | Get-NetFirewallPortFilter
        [pscustomobject]@{
            Name    = $_.DisplayName
            Enabled = $_.Enabled
            Action  = $_.Action
            Profile = $_.Profile
            Port    = $filter.LocalPort
        }
    } | Write-TableBlock
    exit 0
}

# ---------------------------------------------------------------------------
# Remove
# ---------------------------------------------------------------------------
if ($Remove) {
    $rules = @(Get-NetFirewallRule -Group $GROUP -ErrorAction SilentlyContinue)
    if ($rules.Count -eq 0) {
        Write-Info 'nothing to remove'
        exit 0
    }
    foreach ($rule in $rules) {
        Write-Step $rule.DisplayName
        if ($PSCmdlet.ShouldProcess($rule.DisplayName, 'remove firewall rule')) {
            Remove-NetFirewallRule -Name $rule.Name
            Write-Ok 'removed'
        } else {
            Write-Skip 'would remove'
        }
    }
    Write-Host ''
    Write-Host '  All BrandLens firewall rules removed.' -ForegroundColor Green
    Write-Host ''
    exit 0
}

# ---------------------------------------------------------------------------
# Ports for the chosen mode
# ---------------------------------------------------------------------------
$envMap = Read-DotEnv
$apiPort = [int](Get-EnvValue -Key 'API_PORT' -Env $envMap -Default '4000')
$webPort = [int](Get-EnvValue -Key 'WEB_PORT' -Env $envMap -Default '3000')
$enginePort = [int](Get-EnvValue -Key 'ENGINE_PORT' -Env $envMap -Default '8000')

$wanted = @()
switch ($Mode) {
    'Proxy' {
        $wanted += @{ Name = 'BrandLens - HTTP (Caddy)'; Port = 80; Why = 'ACME HTTP-01 challenge and the redirect to HTTPS' }
        $wanted += @{ Name = 'BrandLens - HTTPS (Caddy)'; Port = 443; Why = 'the only public listener' }
    }
    'Direct' {
        $wanted += @{ Name = 'BrandLens - Web console'; Port = $webPort; Why = 'Next.js console, no TLS of its own' }
        $wanted += @{ Name = 'BrandLens - API'; Port = $apiPort; Why = 'REST + MCP surface, no TLS of its own' }
    }
    'LocalOnly' { }
}

if ($AllowPostgres) {
    $wanted += @{ Name = 'BrandLens - PostgreSQL'; Port = 5432; Why = 'database access from a separate app host' }
}

$profileValue = if ($FirewallProfile -contains 'Any') { 'Any' } else { $FirewallProfile -join ',' }

if ($Mode -eq 'Direct') {
    Write-Warn 'Direct mode exposes plaintext HTTP. The API carries bearer tokens and'
    Write-Warn 'API keys, so use it only behind an existing TLS terminator.'
    Write-Host ''
}

if ($RemoteAddress -contains 'Any' -and $Mode -ne 'LocalOnly') {
    Write-Warn "-RemoteAddress is 'Any'. Restricting the source range is the single"
    Write-Warn "cheapest hardening step available:  -RemoteAddress 'LocalSubnet'"
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------
foreach ($rule in $wanted) {
    Write-Step "$($rule.Name) ($($rule.Port))"
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue

    if (-not $PSCmdlet.ShouldProcess($rule.Name, "allow inbound TCP $($rule.Port)")) {
        Write-Skip 'would create'
        continue
    }

    # Idempotent by replacement: re-running with different parameters should
    # converge, not accumulate near-duplicate rules that are impossible to audit.
    if ($existing) { Remove-NetFirewallRule -DisplayName $rule.Name }

    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Group $GROUP `
        -Description $rule.Why `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $rule.Port `
        -RemoteAddress $RemoteAddress `
        -Profile $profileValue `
        -Enabled True | Out-Null

    $verb = if ($existing) { 'updated' } else { 'created' }
    Write-Ok "$verb (profiles: $profileValue, from: $($RemoteAddress -join ','))"
}

if ($wanted.Count -eq 0) {
    Write-Step 'rules'
    Write-Skip 'LocalOnly mode -- no inbound rules created'
}

# ---------------------------------------------------------------------------
# Audit: is anything listening beyond loopback that should not be?
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Binding audit' -ForegroundColor Cyan

$internalPorts = @(
    @{ Port = $enginePort; Name = 'engine'; MustBeLocal = $true },
    @{ Port = $apiPort; Name = 'api'; MustBeLocal = ($Mode -eq 'Proxy' -or $Mode -eq 'LocalOnly') },
    @{ Port = $webPort; Name = 'web'; MustBeLocal = ($Mode -eq 'Proxy' -or $Mode -eq 'LocalOnly') },
    @{ Port = 5432; Name = 'postgresql'; MustBeLocal = (-not $AllowPostgres) }
)

$exposed = @()
foreach ($entry in $internalPorts) {
    $listeners = @(Get-NetTCPConnection -LocalPort $entry.Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        Write-Info ("{0,-12} {1,-6} not listening" -f $entry.Name, $entry.Port)
        continue
    }
    $addresses = ($listeners.LocalAddress | Select-Object -Unique) -join ', '
    # 0.0.0.0 / :: mean "every interface" -- reachable from the network.
    $wide = @($listeners | Where-Object { $_.LocalAddress -in @('0.0.0.0', '::') })
    if ($wide.Count -gt 0 -and $entry.MustBeLocal) {
        Write-Host ("  {0,-12} {1,-6} {2}" -f $entry.Name, $entry.Port, $addresses) -ForegroundColor Yellow
        $exposed += $entry
    } else {
        Write-Host ("  {0,-12} {1,-6} {2}" -f $entry.Name, $entry.Port, $addresses) -ForegroundColor Green
    }
}

if ($exposed.Count -gt 0) {
    Write-Host ''
    Write-Warn 'The following are listening on every interface but should be loopback-only:'
    foreach ($entry in $exposed) { Write-Warn "  $($entry.Name) on port $($entry.Port)" }
    Write-Host ''
    Write-Hint @(
        'Fix the binding, not the firewall:',
        '  .env                  API_HOST=127.0.0.1',
        '  .env                  ENGINE_HOST=127.0.0.1',
        '  postgresql.conf       listen_addresses = ''localhost''',
        '',
        'Then:  .\stop-all.ps1 ; .\start-all.ps1   (and Restart-Service postgresql-x64-16)'
    )
}

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Firewall configured.' -ForegroundColor Green
Write-Host ''
Write-Host '  Topology' -ForegroundColor Cyan
switch ($Mode) {
    'Proxy' {
        Write-Host '    internet --> :80/:443 Caddy --> 127.0.0.1:3000 (web)'
        Write-Host '                                --> 127.0.0.1:4000 (api)'
        Write-Host '    engine (8000) and postgres (5432) never leave loopback.'
        Write-Host ''
        Write-Host '    Caddy config:  infra\caddy\Caddyfile' -ForegroundColor DarkGray
    }
    'Direct' {
        Write-Host "    clients --> :$webPort (web), :$apiPort (api)   [plaintext HTTP]"
        Write-Host '    engine (8000) and postgres (5432) remain loopback-only.'
    }
    'LocalOnly' {
        Write-Host '    nothing is exposed; reach the services over RDP or an SSH tunnel.'
    }
}
Write-Host ''
Write-Host '  Review:  .\firewall.ps1 -List' -ForegroundColor Cyan
Write-Host '  Undo:    .\firewall.ps1 -Remove' -ForegroundColor Cyan
Write-Host ''
exit 0
