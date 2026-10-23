# Публикация содержимого web/ на GitHub Pages (ветка gh-pages).
# Запуск из папки Physics_KIM_Generator:
#   powershell -ExecutionPolicy Bypass -File .\deploy-web.ps1
#
# Ветка gh-pages пересобирается из web/ и пушится в origin.
# Ответы и база задач на GitHub не попадают.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$remote = 'origin'
$pagesUrl = 'https://znormalnyj-dot.github.io/physics-kim/'

Write-Host '[1/4] Проверяем git-репозиторий...'
if (-not (Test-Path '.git')) {
  throw 'Не найден .git. Запустите скрипт из папки Physics_KIM_Generator.'
}

Write-Host '[2/4] Фиксируем изменения проекта в main...'
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m 'Update project before web deploy'
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать коммит.' }
} else {
  Write-Host '      Изменений нет — коммит не нужен.'
}

Write-Host '[3/4] Пересобираем ветку gh-pages из web/...'
git branch -D gh-pages 2>$null | Out-Null
git subtree split --prefix=web -b gh-pages
if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать ветку gh-pages.' }

Write-Host '[4/4] Публикуем на GitHub Pages...'
git push $remote gh-pages --force
if ($LASTEXITCODE -ne 0) { throw 'Не удалось выполнить git push. Проверьте авторизацию GitHub.' }

Write-Host ''
Write-Host "Готово: $pagesUrl"
Write-Host 'Обновление Pages обычно занимает 1–2 минуты.'
