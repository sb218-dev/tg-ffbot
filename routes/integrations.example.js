const express = require('express');

module.exports = (db, bot, config) => {
    const router = express.Router();

    // Webhook для Яндекс Еды
    router.post('/integrations/yandex/webhook', (req, res) => {
        // TODO: Обработка заказа Yandex и проверка токенов авторизации
        res.status(200).send('OK');
    });

    // Webhook для Купер (Kuper)
    router.post('/integrations/kuper/webhook', (req, res) => {
        // TODO: Обработка заказа Kuper и проверка токенов авторизации
        res.status(200).send('OK');
    });

    // Webhook для QuickResto
    router.post('/integrations/quickresto/webhook', (req, res) => {
        // TODO: Обработка заказа QuickResto и проверка токенов авторизации
        res.status(200).send('OK');
    });

    return router;
};