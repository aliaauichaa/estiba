# Despliegue de Estiba en AWS
#   .\deploy.ps1            -> compila la web y la sube a S3 + invalida CloudFront
#   .\deploy.ps1 -Lambda    -> ademas sube el codigo del asistente (lambda/asistente)
# Recursos (creados el 07-oct-2026):
#   Web: bucket estiba-web (eu-south-2, privado, OAC) + CloudFront E1LED0757CV5D3 -> https://d1ex3zlctjya5a.cloudfront.net
#   Asistente: Lambda estiba-asistente (eu-south-2, rol estiba-asistente-role, concurrencia reservada 3, TOPE_DIARIO=300)
#     Function URL publica con CORS solo para la web y localhost:5190; llama a Claude Haiku 4.5 en Bedrock us-east-1.
param([switch]$Lambda)
$ErrorActionPreference = 'Stop'
$Region = 'eu-south-2'
$Api = 'https://dnzqql23zkuwpjwv7mq54eht7a0sihey.lambda-url.eu-south-2.on.aws/'
Set-Location $PSScriptRoot

if ($Lambda) {
  if (Test-Path asistente.zip) { Remove-Item asistente.zip }
  # ficha-ali.mjs es copia de Proyecto IA/ficha-ali (node sincronizar.mjs): preguntas sobre Ali (ali.mjs, ruta.mjs).
  Compress-Archive -Path lambda/asistente/index.mjs, lambda/asistente/cifras.mjs, lambda/asistente/acciones.mjs, lambda/asistente/ruta.mjs, lambda/asistente/ali.mjs, lambda/asistente/ficha-ali.mjs -DestinationPath asistente.zip -Force
  aws lambda update-function-code --region $Region --function-name estiba-asistente --zip-file fileb://asistente.zip --query "[FunctionName,LastUpdateStatus]" --output text
  aws lambda wait function-updated --region $Region --function-name estiba-asistente
  Remove-Item asistente.zip
}

npm test
if ($LASTEXITCODE -ne 0) { throw 'Las pruebas fallan: no se despliega.' }
$env:VITE_ESTIBA_API = $Api
npx vite build
if ($LASTEXITCODE -ne 0) { throw 'Fallo al compilar.' }
Remove-Item Env:\VITE_ESTIBA_API

aws s3 sync dist/assets s3://estiba-web/assets --region $Region --delete --cache-control "public,max-age=31536000,immutable" --only-show-errors
aws s3 cp dist/favicon.svg s3://estiba-web/favicon.svg --region $Region --cache-control "public,max-age=86400" --only-show-errors
aws s3 cp dist/index.html s3://estiba-web/index.html --region $Region --cache-control "no-cache" --only-show-errors
aws cloudfront create-invalidation --distribution-id E1LED0757CV5D3 --paths "/index.html" "/" --query "Invalidation.Status" --output text
Write-Host "Web: https://d1ex3zlctjya5a.cloudfront.net"
