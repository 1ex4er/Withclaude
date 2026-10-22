# CHNGZ_Artifact — артефакты со свечением для DayZ

Свечение — точечный источник света (`PointLightBase`), который висит на предмете:
освещает землю и руки вокруг, сама текстура не белеет (в rvmat `emmisive = 0`).
Светит, когда артефакт лежит на земле или в руках; в инвентаре гаснет (`glowInInventory = 1` — светит всегда).

## Сборка (на ПК с DayZ Tools)
1. DayZ Tools → смонтировать диск P:.
2. Модели и текстуры — в `C:\Users\iishi\Desktop\art`. Текстуры: `имя_co.png` (цвет), по желанию
   `имя_nohq.png` (нормали) и `имя_smdi.png` (блеск). JPG/PSD пересохранить в PNG/TGA.
3. Запуск из корня репозитория:
   ```
   powershell -ExecutionPolicy Bypass -File dayz\tools\build.ps1
   ```
   Результат: `P:\@CHNGZ_Artifact\Addons\CHNGZ_Artifact.pbo` + `.bisign`, ключ `Keys\CHNGZ.bikey`.
   Приватный ключ — `P:\CHNGZ_Keys\CHNGZ.biprivatekey`, никому не отдавать.

## Модели FBX/OBJ → p3d (один раз на модель, вручную в Object Builder)
Скрипт перечислит такие файлы в конце. Для каждого:
1. Object Builder → File → Import → FBX (масштаб 1 = 1 м).
2. LOD 1.000 (визуальный): выделить всё → Face Properties → Texture
   `CHNGZ_Artifact\data\textures\имя_co.paa`, Material `CHNGZ_Artifact\data\textures\имя.rvmat`
   (rvmat создаёт первый прогон скрипта).
3. Добавить LOD **Geometry** (простой бокс, Mass > 0, named property `autocenter = 0`),
   **View Geometry**/**Fire Geometry** — копия геометрии, **Memory** — можно пустой.
4. Сохранить как `P:\CHNGZ_Artifact\data\models\имя.p3d` и запустить `build.ps1` ещё раз.

## Настройка артефактов
`P:\CHNGZ_Artifact\artifacts.csv` (разделитель `;`) — по строке на модель: класс, название, описание,
цвет свечения `r g b` (0..1), `radius` (м), `brightness`, `pulse` (0 — ровный свет), вес.
После правки — снова `build.ps1`.

Спавн: классы `CHNGZ_Art_<имя>` — в `types.xml` сервера.
