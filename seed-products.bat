@echo off
echo Seeding DIGNITYARTEDGE products...
cd /d C:\code_spance\codeproject\etcy\backend
npx tsx prisma/seed-products.ts
echo.
pause
