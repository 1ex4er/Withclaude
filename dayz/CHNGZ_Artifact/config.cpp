class CfgPatches
{
	class CHNGZ_Artifact
	{
		units[] = {};
		weapons[] = {};
		requiredVersion = 0.1;
		requiredAddons[] = {"DZ_Data", "DZ_Scripts", "DZ_Gear_Consumables"};
	};
};

class CfgMods
{
	class CHNGZ_Artifact
	{
		dir = "CHNGZ_Artifact";
		name = "CHNGZ Artifact";
		author = "LX x CHNGZ";
		type = "mod";
		dependencies[] = {"World"};
		class defs
		{
			class worldScriptModule
			{
				value = "";
				files[] = {"CHNGZ_Artifact/scripts/4_World"};
			};
		};
	};
};

class CfgVehicles
{
	class Inventory_Base;

	// Базовый класс артефакта. Свечение — настоящий точечный источник света
	// (PointLightBase), а не emissive в rvmat, поэтому текстура не «выбеливается».
	class CHNGZ_ArtifactBase: Inventory_Base
	{
		scope = 0;
		displayName = "Артефакт";
		descriptionShort = "Аномальное образование.";
		weight = 500;
		itemSize[] = {1, 1};
		rotationFlags = 17;
		canBeDigged = 0;
		absorbency = 0;
		varQuantityInit = 0;

		// Параметры свечения: цвет RGB 0..1, радиус в метрах, яркость,
		// пульсация (0 — ровный свет), скорость пульсации.
		glowColor[] = {0.4, 0.8, 1.0};
		glowRadius = 2.5;
		glowBrightness = 1.2;
		glowPulse = 0.25;
		glowPulseSpeed = 1.5;
		// Светит на земле и в руках; 1 — светит ещё и в инвентаре/контейнерах.
		glowInInventory = 0;
	};

	// Классы конкретных артефактов генерирует tools/build.ps1 из artifacts.csv.
	#include "artifacts.hpp"
};
