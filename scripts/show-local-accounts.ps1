$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$accountPath = Join-Path $PSScriptRoot '../data/local-demo-accounts.json'
$protectedText = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $accountPath))
if (-not $protectedText.StartsWith('dpapi:v1:')) { throw 'Protected account handoff required.' }
$entropy = [Text.Encoding]::UTF8.GetBytes('SynCare.local.private.v1')
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($protectedText.Substring(9)), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$accounts = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json
$entries = @($accounts.nurses) + @($accounts.patients)
$window = New-Object Windows.Forms.Form
$window.Text = 'Akun demo SynCare — privat'
$window.Size = New-Object Drawing.Size(600,330)
$list = New-Object Windows.Forms.ListBox
$list.Location = New-Object Drawing.Point(16,16)
$list.Size = New-Object Drawing.Size(550,180)
foreach ($account in $entries) { [void]$list.Items.Add($account.identifier) }
$copy = New-Object Windows.Forms.Button
$copy.Text = 'Salin kata sandi akun terpilih'
$copy.Location = New-Object Drawing.Point(16,212)
$copy.Size = New-Object Drawing.Size(280,36)
$copy.Add_Click({ if ($list.SelectedIndex -ge 0) { [Windows.Forms.Clipboard]::SetText($entries[$list.SelectedIndex].password); $window.Text = 'Kata sandi disalin — jangan bagikan atau rekam layar' } })
$window.Controls.Add($list)
$window.Controls.Add($copy)
[void]$window.ShowDialog()
[Array]::Clear($plainBytes,0,$plainBytes.Length)
