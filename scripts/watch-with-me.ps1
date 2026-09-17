#!/usr/bin/env pwsh
[CmdletBinding()] param([Parameter(Position=0)][string]$Command = 'help', [Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ComposeFile = Join-Path $Root 'docker-compose.yml'
$Timeout = [int]($env:WATCH_WITH_ME_TIMEOUT ?? 120)
$Services = @('postgres','redis','minio','livekit','coturn','media-worker','realtime','web')
function Fail([string]$Message) { Write-Error "watch-with-me: $Message"; exit 1 }
function Resolve-LiveKitNodeIp {
  if ($env:LIVEKIT_NODE_IP -and $env:LIVEKIT_NODE_IP -match '^(?:\d{1,3}\.){3}\d{1,3}$' -and $env:LIVEKIT_NODE_IP -notmatch '^(127\.|169\.254\.|0\.)') { return $env:LIVEKIT_NODE_IP }
  $configs = @(Get-NetIPConfiguration | Where-Object {
    $_.IPv4DefaultGateway -and $_.IPv4Address -and
    $_.InterfaceAlias -notmatch 'Docker|Hyper-V|vEthernet|WSL|Loopback'
  })
  foreach ($config in $configs) {
    $address = @($config.IPv4Address | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|0\.)' } | Select-Object -ExpandProperty IPAddress)
    if ($address.Count -gt 0) { return [string]$address[0] }
  }
  Fail 'could not detect a LAN IPv4 address; set LIVEKIT_NODE_IP explicitly.'
}
function Set-LiveKitNetwork { }
function Usage { @('Usage: watch-with-me <command>','  start [--no-build] | stop | restart [--no-build] | status | health','  logs [web|realtime|postgres|redis|minio|livekit|media-worker] [--follow] [--tail N]','  remove | clean [--yes] | test | doctor | config | help') | Write-Output }
function Compose([string[]]$Arguments) { & docker compose -f $ComposeFile @Arguments; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
function Preflight { if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker CLI is not available.' }; & docker info *> $null; if ($LASTEXITCODE -ne 0) { Fail 'Docker daemon is unavailable; start Docker and retry.' }; & docker compose -f $ComposeFile config *> $null; if ($LASTEXITCODE -ne 0) { Fail 'docker-compose.yml is invalid or unavailable.' } }
function Healthy([string]$Service) { $ids = @(& docker compose -f $ComposeFile ps -q $Service 2>$null); if ($ids.Count -eq 0) { return $false }; $id = [string]$ids[0]; if ([string]::IsNullOrWhiteSpace($id)) { return $false }; $states = @(& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $id 2>$null); if ($states.Count -eq 0) { return $false }; return ([string]$states[0]).Trim() -eq 'healthy' }
function WaitReady { $end=(Get-Date).AddSeconds($Timeout); do { if (($Services | Where-Object { -not (Healthy $_) }).Count -eq 0) { try { Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 3 *> $null; Write-Output "watch-with-me: all services healthy and web is responding (within ${Timeout}s)."; return } catch {} }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $end); Write-Error "watch-with-me: timed out after ${Timeout}s waiting for service health/HTTP."; Compose @('ps'); exit 1 }
function Doctor { Preflight; foreach ($port in @(3000,4000)) { $published = (& docker ps --format '{{.Ports}}') -match "(127\.0\.0\.1|0\.0\.0\.0|::):$port->"; if ($published) { Write-Warning "doctor: port $port is already published by a Docker container (no process will be killed)." }; try { $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop); if ($listeners.Count) { Write-Warning "doctor: port $port is occupied by a listening host process (no process will be killed)." } } catch {} }; Write-Output 'doctor: Docker, daemon, compose configuration, and port checks passed.' }
switch ($Command) {
  {$_ -in @('help','-h','--help')} { Usage; break }
  'doctor' { Set-LiveKitNetwork; Doctor; break }
  'config' { Preflight; Compose @('config'); break }
  'start' { Set-LiveKitNetwork; Preflight; $build=$true; if ($Args -contains '--no-build') {$build=$false;$Args=@($Args|Where-Object{$_ -ne '--no-build'})}; if($Args.Count){Fail 'start accepts only --no-build.'}; if($build){Compose @('up','--build','-d')}else{Compose @('up','-d')}; WaitReady; break }
  'stop' { Preflight; if($Args.Count){Fail 'stop takes no arguments.'}; Compose @('stop'); break }
  'restart' { Set-LiveKitNetwork; Preflight; $build=$true; if ($Args -contains '--no-build') {$build=$false;$Args=@($Args|Where-Object{$_ -ne '--no-build'})}; if($Args.Count){Fail 'restart accepts only --no-build.'}; Compose @('stop'); if($build){Compose @('up','--build','-d')}else{Compose @('up','-d')}; WaitReady; break }
  'status' { Preflight; if($Args.Count){Fail 'status takes no arguments.'}; Compose @('ps'); break }
  'health' { Preflight; if($Args.Count){Fail 'health takes no arguments.'}; WaitReady; break }
  'logs' { Preflight; if($Args.Count -lt 1 -or $Args[0] -notin $Services){Fail 'logs requires an allowed service.'}; $service=$Args[0]; $follow=$false;$tail='100'; for($i=1;$i -lt $Args.Count;$i++){switch($Args[$i]){'--follow'{$follow=$true};'--tail'{if(++$i -ge $Args.Count -or $Args[$i] -notmatch '^[0-9]+$'){Fail '--tail requires a non-negative integer.'};$tail=$Args[$i]};default{Fail 'unknown logs option.'}}}; $a=@('logs','--tail',$tail);if($follow){$a+='--follow'};$a+=$service;Compose $a;break }
  'remove' { Preflight; if($Args.Count){Fail 'remove takes no arguments.'}; Compose @('down','--remove-orphans');break }
  'clean' { Preflight; $yes=$Args -contains '--yes';if(@($Args|Where-Object{$_ -ne '--yes'}).Count){Fail 'clean accepts only --yes.'};if(-not $yes){$answer=Read-Host 'Type DELETE to remove containers, networks, and volumes';if($answer -cne 'DELETE'){Fail 'clean cancelled.'}};Compose @('down','--volumes','--remove-orphans');break }
  'test' { Set-LiveKitNetwork; Preflight;WaitReady;if(-not(Get-Command npm -ErrorAction SilentlyContinue)){Fail 'npm is not available; install Node.js/npm before running Docker E2E tests.'};$pkg=Get-Content (Join-Path $Root 'package.json') -Raw;if($pkg -notmatch '"test:e2e:docker"'){Fail 'npm script test:e2e:docker is not present yet; do not run test until it is added.'};& npm --prefix $Root run test:e2e:docker;exit $LASTEXITCODE }
  default { Fail "unknown command '$Command'; use help." }
}
