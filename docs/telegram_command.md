## Connect Telegram Bot for testing (localhost) 
curl.exe "https://api.telegram.org/bot8769581004:AAF05TV3NmzsgBYCqMRUkWSWG44AmP-HAeo/getUpdates"


curl.exe "https://api.telegram.org/bot<PASTE-TOKEN>/getWebhookInfo"


curl.exe "https://api.telegram.org/bot<PASTE-TOKEN>/deleteWebhook"

curl.exe -X POST http://localhost:3000/api/integrations/telegram/webhook -H "Content-Type: application/json" -H "x-telegram-bot-api-secret-token: cd5a085034d45e7813b9932b358d7918fdf3daf6c19c31e1" -d "{\"message\":{\"text\":\"/start ksPHcFG0SOuxlv5yFK8mGWpQkFAw0lCcM_QiNJJ2-ellYRQC\",\"chat\":{\"id\":7962877873}}}"


    $body = @{
    message = @{
        text = "/start ksPHcFG0SOuxlv5yFK8mGWpQkfAmzv0F9boghBGhzu4_YyDB"
        chat = @{ id = 7962877873 }
    }
    } | ConvertTo-Json -Depth 5

    Invoke-RestMethod -Method Post `
    -Uri "http://localhost:3000/api/integrations/telegram/webhook" `
    -Headers @{ "x-telegram-bot-api-secret-token" = "cd5a085034d45e7813b9932b358d7918fdf3daf6c19c31e1" } `
    -ContentType "application/json" `
    -Body $body


    $body = '{"message":{"text":"/start <CODE>","chat":{"id":7962877873}}}'
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/integrations/telegram/webhook -ContentType "application/json" -Headers @{ "x-telegram-bot-api-secret-token" = "<TELEGRAM_WEBHOOK_SECRET>" } -Body $body


## Testing (localhost)

curl.exe -i http://localhost:3000/api/cron/reminders

curl.exe -H "Authorization: Bearer cb77880f8205e19f33252dcbe10a70e61276aaca12e29d86" "http://localhost:3000/api/cron/reminders?dry=1"

curl.exe -H "Authorization: Bearer cb77880f8205e19f33252dcbe10a70e61276aaca12e29d86" "http://localhost:3000/api/cron/reminders"