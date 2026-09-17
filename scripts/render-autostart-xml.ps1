<#
  把 scripts\autostart-task.xml 模板渲染成一份带真实路径的任务定义文件。

  为什么需要它：
  - 路径里可能出现 & < > 等需要在 XML 里转义的字符，纯 bat 的字符串替换做不到安全转义。
  - schtasks /create /xml 只接受 Unicode(UTF-16LE) 编码的定义文件，bat 写不出这种编码。
#>
param(
  [Parameter(Mandatory = $true)][string]$Template,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$Runner,
  [Parameter(Mandatory = $true)][string]$ProjectDir
)

$ErrorActionPreference = 'Stop'

$escape = { param([string]$value) [System.Security.SecurityElement]::Escape($value) }

if (-not (Test-Path -LiteralPath $Template)) {
  Write-Error "找不到任务定义模板：$Template"
}

$xml = Get-Content -LiteralPath $Template -Raw -Encoding UTF8
$xml = $xml.Replace('__USER__', (& $escape $User))
$xml = $xml.Replace('__RUNNER__', (& $escape $Runner))
$xml = $xml.Replace('__PROJECT_DIR__', (& $escape $ProjectDir))

$utf16WithBom = New-Object System.Text.UnicodeEncoding($false, $true)
[System.IO.File]::WriteAllText($Destination, $xml, $utf16WithBom)

Write-Output "已生成任务定义：$Destination"
