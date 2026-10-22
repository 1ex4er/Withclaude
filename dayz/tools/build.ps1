# Сборка мода CHNGZ_Artifact: импорт моделей и текстур, генерация классов,
# упаковка AddonBuilder и подпись DSSignFile.
#
#   powershell -ExecutionPolicy Bypass -File dayz\tools\build.ps1
#
param(
	[string]$ArtDir = "$env:USERPROFILE\Desktop\art",
	[string]$Source = (Join-Path $PSScriptRoot "..\CHNGZ_Artifact"),
	[string]$Work = "P:\CHNGZ_Artifact",
	[string]$Out = "P:\@CHNGZ_Artifact",
	[string]$KeyDir = "P:\CHNGZ_Keys",
	[string]$KeyName = "CHNGZ",
	[string]$Tools = ""
)
$ErrorActionPreference = "Stop"

function Find-DayZTools {
	if ($Tools -and (Test-Path $Tools)) { return $Tools }
	foreach ($k in "HKCU:\Software\Bohemia Interactive\Dayz Tools", "HKLM:\SOFTWARE\WOW6432Node\Bohemia Interactive\Dayz Tools") {
		$p = (Get-ItemProperty $k -ErrorAction SilentlyContinue).path
		if ($p -and (Test-Path $p)) { return $p }
	}
	$d = "C:\Program Files (x86)\Steam\steamapps\common\DayZ Tools"
	if (Test-Path $d) { return $d }
	throw "DayZ Tools не найдены. Укажи путь: -Tools 'D:\...\DayZ Tools'"
}

$Tools = Find-DayZTools
$ImageToPAA = Join-Path $Tools "Bin\ImageToPAA\ImageToPAA.exe"
$AddonBuilder = Join-Path $Tools "Bin\AddonBuilder\AddonBuilder.exe"
$DSCreateKey = Join-Path $Tools "Bin\DsUtils\DSCreateKey.exe"
$DSSignFile = Join-Path $Tools "Bin\DsUtils\DSSignFile.exe"
if (-not (Test-Path "P:\")) { throw "Диск P: не смонтирован — запусти DayZ Tools > Mount P drive" }
Write-Host "DayZ Tools: $Tools"

# 1. Исходники мода -> P:\CHNGZ_Artifact (data и artifacts.csv не трогаем)
New-Item -ItemType Directory -Force "$Work\data\models", "$Work\data\textures" | Out-Null
Copy-Item (Join-Path $Source "config.cpp") $Work -Force
Copy-Item (Join-Path $Source "scripts") $Work -Recurse -Force

# 2. Импорт из папки art
$models = "$Work\data\models"
$textures = "$Work\data\textures"
$needOB = @()
if (Test-Path $ArtDir) {
	foreach ($f in Get-ChildItem $ArtDir -Recurse -File) {
		switch ($f.Extension.ToLower()) {
			".p3d" { Copy-Item $f.FullName $models -Force }
			".paa" { Copy-Item $f.FullName $textures -Force }
			{ $_ -in ".png", ".tga" } {
				$dst = Join-Path $textures ($f.BaseName + ".paa")
				if (-not (Test-Path $dst) -or (Get-Item $dst).LastWriteTime -lt $f.LastWriteTime) {
					& $ImageToPAA $f.FullName $dst | Out-Null
					Write-Host "PAA: $($f.Name)"
				}
			}
			{ $_ -in ".jpg", ".jpeg", ".bmp", ".dds", ".psd" } {
				Write-Warning "$($f.Name): пересохрани в PNG или TGA (ImageToPAA их не берёт)"
			}
			{ $_ -in ".fbx", ".obj", ".3ds", ".blend", ".dae" } { $needOB += $f.FullName }
		}
	}
} else {
	Write-Warning "Папка $ArtDir не найдена — собираю из того, что уже лежит в $Work\data"
}

# 3. rvmat для каждого *_co: обычный Super-шейдер, emmisive = 0 (текстура не белеет)
Get-ChildItem $textures -Filter "*_co.paa" | ForEach-Object {
	$base = $_.BaseName -replace "_co$", ""
	$rvmat = Join-Path $textures "$base.rvmat"
	if (Test-Path $rvmat) { return }
	$nohq = if (Test-Path "$textures\${base}_nohq.paa") { "CHNGZ_Artifact\data\textures\${base}_nohq.paa" } else { "#(argb,8,8,3)color(0.5,0.5,1,1,NOHQ)" }
	$smdi = if (Test-Path "$textures\${base}_smdi.paa") { "CHNGZ_Artifact\data\textures\${base}_smdi.paa" } else { "#(argb,8,8,3)color(0,0.3,0.6,1,SMDI)" }
	@"
ambient[]={1,1,1,1};
diffuse[]={1,1,1,1};
forcedDiffuse[]={0,0,0,0};
emmisive[]={0,0,0,1};
specular[]={0.4,0.4,0.4,1};
specularPower=60;
PixelShaderID="Super";
VertexShaderID="Super";
class Stage1 { texture="$nohq"; uvSource="tex"; class uvTransform { aside[]={1,0,0}; up[]={0,1,0}; dir[]={0,0,0}; pos[]={0,0,0}; }; };
class Stage2 { texture="#(argb,8,8,3)color(0.5,0.5,0.5,1,DT)"; uvSource="tex"; class uvTransform { aside[]={1,0,0}; up[]={0,1,0}; dir[]={0,0,0}; pos[]={0,0,0}; }; };
class Stage3 { texture="#(argb,8,8,3)color(0,0,0,0,MC)"; uvSource="tex"; class uvTransform { aside[]={1,0,0}; up[]={0,1,0}; dir[]={0,0,0}; pos[]={0,0,0}; }; };
class Stage4 { texture="#(argb,8,8,3)color(1,1,1,1,AS)"; uvSource="tex"; class uvTransform { aside[]={1,0,0}; up[]={0,1,0}; dir[]={0,0,0}; pos[]={0,0,0}; }; };
class Stage5 { texture="$smdi"; uvSource="tex"; class uvTransform { aside[]={1,0,0}; up[]={0,1,0}; dir[]={0,0,0}; pos[]={0,0,0}; }; };
class Stage6 { texture="#(ai,64,64,1)fresnel(1.5,0.3)"; uvSource="none"; };
class Stage7 { texture="DZ\data\data\env_land_co.paa"; uvSource="none"; };
"@ | Set-Content -Encoding ASCII $rvmat
	Write-Host "RVMAT: $base.rvmat"
}

# 4. artifacts.csv: новые модели дописываются с настройками по умолчанию
$csv = "$Work\artifacts.csv"
$rows = @()
if (Test-Path $csv) { $rows = @(Import-Csv $csv -Delimiter ";" -Encoding UTF8) }
Get-ChildItem $models -Filter "*.p3d" | ForEach-Object {
	$name = $_.BaseName
	if (-not ($rows | Where-Object { $_.model -eq $name })) {
		$rows += [pscustomobject]@{
			model = $name; class = "CHNGZ_Art_" + ($name -replace "[^A-Za-z0-9_]", "_")
			displayName = $name; description = "Аномальное образование."
			r = "0.4"; g = "0.8"; b = "1.0"; radius = "2.5"; brightness = "1.2"; pulse = "0.25"; weight = "500"
		}
		Write-Host "Новый артефакт: $name"
	}
}
$rows | Export-Csv $csv -Delimiter ";" -NoTypeInformation -Encoding UTF8

# 5. artifacts.hpp
$hpp = @("// Сгенерировано build.ps1 из artifacts.csv — правь CSV, а не этот файл.")
foreach ($a in $rows) {
	if (-not (Test-Path "$models\$($a.model).p3d")) { Write-Warning "Нет модели $($a.model).p3d — класс пропущен"; continue }
	$hpp += @"
	class $($a.class): CHNGZ_ArtifactBase
	{
		scope = 2;
		displayName = "$($a.displayName)";
		descriptionShort = "$($a.description)";
		model = "CHNGZ_Artifact\data\models\$($a.model).p3d";
		weight = $($a.weight);
		glowColor[] = {$($a.r), $($a.g), $($a.b)};
		glowRadius = $($a.radius);
		glowBrightness = $($a.brightness);
		glowPulse = $($a.pulse);
	};
"@
}
[IO.File]::WriteAllText("$Work\artifacts.hpp", ($hpp -join "`r`n"), (New-Object Text.UTF8Encoding $false))

# 6. Ключ подписи (создаётся один раз; .biprivatekey никому не отдавать)
New-Item -ItemType Directory -Force $KeyDir | Out-Null
if (-not (Test-Path "$KeyDir\$KeyName.biprivatekey")) {
	Push-Location $KeyDir; & $DSCreateKey $KeyName; Pop-Location
}

# 7. Упаковка
New-Item -ItemType Directory -Force "$Out\Addons", "$Out\Keys" | Out-Null
$include = Join-Path $env:TEMP "chngz_include.txt"
"*.p3d;*.paa;*.rvmat;*.c;*.hpp;*.cpp;*.csv" | Set-Content -Encoding ASCII $include
& $AddonBuilder $Work "$Out\Addons" -clear -prefix="CHNGZ_Artifact" -project="P:\" -include="$include"
$pbo = "$Out\Addons\CHNGZ_Artifact.pbo"
if (-not (Test-Path $pbo)) { throw "AddonBuilder не создал $pbo — смотри его лог выше" }

# 8. Подпись
Get-ChildItem "$Out\Addons" -Filter "*.bisign" | Remove-Item
& $DSSignFile "$KeyDir\$KeyName.biprivatekey" $pbo
Copy-Item "$KeyDir\$KeyName.bikey" "$Out\Keys" -Force

@"
name = "CHNGZ Artifact";
author = "LX x CHNGZ";
version = "1.0";
"@ | Set-Content -Encoding ASCII "$Out\mod.cpp"

Write-Host ""
Write-Host "Готово: $Out" -ForegroundColor Green
Write-Host "Классы и свечение: $csv (после правки — запусти сборку снова)"
if ($needOB.Count) {
	Write-Warning "Эти модели нужно один раз импортировать в Object Builder и сохранить как .p3d в $models :"
	$needOB | ForEach-Object { Write-Host "  $_" }
}
