const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const app = express();

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const ACK_TIMEOUT_MS = parseInt(process.env.ACK_TIMEOUT_MS) || 10000; // 10 segundos
const PORT = process.env.PORT || 3000;

// Mapeamento dos produtos Kirvano
const PRODUCT_MAPPING = {
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FAB'
};

// Instâncias Evolution (fallback sequencial)
const INSTANCES = ['GABY01', 'GABY02', 'GABY03', 'GABY04', 'GABY05', 'GABY06', 'GABY07', 'GABY08', 'GABY09'];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let pendingAcks = new Map();
let idempotencyCache = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let logs = [];
let funis = new Map();

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA',
        name: 'CS - Compra Aprovada',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Parabéns! Seu pedido foi aprovado. Bem-vindo ao CS!',
                waitForReply: true,
                timeoutMinutes: 60,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pela resposta! Aqui estão seus próximos passos...',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Lembre-se de acessar nossa plataforma. Qualquer dúvida, estamos aqui!',
                waitForReply: false
            }
        ]
    },
    'CS_PIX': {
        id: 'CS_PIX',
        name: 'CS - PIX Pendente',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Seu PIX foi gerado! Aguardamos o pagamento para liberar o acesso ao CS.',
                waitForReply: true,
                timeoutMinutes: 10,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pelo contato! Assim que o pagamento for confirmado, você receberá o acesso.',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'PIX vencido! Entre em contato conosco para gerar um novo.',
                waitForReply: false
            }
        ]
    },
    'FAB_APROVADA': {
        id: 'FAB_APROVADA',
        name: 'FAB - Compra Aprovada',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Parabéns! Seu pedido FAB foi aprovado. Prepare-se para a transformação!',
                waitForReply: true,
                timeoutMinutes: 60,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Que bom que respondeu! Sua jornada FAB começa agora...',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Acesse nossa área de membros e comece sua transformação hoje mesmo!',
                waitForReply: false
            }
        ]
    },
    'FAB_PIX': {
        id: 'FAB_PIX',
        name: 'FAB - PIX Pendente',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Seu PIX FAB foi gerado! Aguardamos o pagamento para iniciar sua transformação.',
                waitForReply: true,
                timeoutMinutes: 10,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pelo contato! Logo após o pagamento, você terá acesso completo ao FAB.',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'PIX vencido! Entre em contato para gerar um novo e não perder essa oportunidade.',
                waitForReply: false
            }
        ]
    }
};

// Inicializar funis padrão
Object.values(defaultFunnels).forEach(funnel => {
    funis.set(funnel.id, funnel);
});

app.use(express.json());

// ============ FUNÇÕES AUXILIARES ============

function normalizePhone(phone) {
    if (!phone) return '';
    
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.length === 10 || cleaned.length === 11) {
        cleaned = '55' + cleaned;
    }
    
    if (!cleaned.startsWith('55')) {
        cleaned = '55' + cleaned;
    }
    
    return cleaned;
}

function phoneToRemoteJid(phone) {
    const normalized = normalizePhone(phone);
    return normalized + '@s.whatsapp.net';
}

function extractMessageText(message) {
    if (!message) return '';
    
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.buttonsResponseMessage?.selectedDisplayText) 
        return message.buttonsResponseMessage.selectedDisplayText;
    if (message.listResponseMessage?.singleSelectReply?.selectedRowId)
        return message.listResponseMessage.singleSelectReply.selectedRowId;
    if (message.templateButtonReplyMessage?.selectedId)
        return message.templateButtonReplyMessage.selectedId;
    
    return '';
}

function checkIdempotency(key, ttl = 5 * 60 * 1000) {
    const now = Date.now();
    
    for (const [k, timestamp] of idempotencyCache.entries()) {
        if (now - timestamp > ttl) {
            idempotencyCache.delete(k);
        }
    }
    
    if (idempotencyCache.has(key)) {
        return true;
    }
    
    idempotencyCache.set(key, now);
    return false;
}

function addLog(type, message, data = null) {
    const log = {
        timestamp: new Date(),
        type,
        message,
        data
    };
    
    logs.unshift(log);
    
    if (logs.length > 1000) {
        logs = logs.slice(0, 1000);
    }
    
    console.log('[' + log.timestamp.toISOString() + '] ' + type + ': ' + message);
}

// ============ EVOLUTION API ADAPTER ============

async function sendToEvolution(instanceName, endpoint, payload) {
    const url = EVOLUTION_BASE_URL + endpoint + '/' + instanceName;
    
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 15000
        });
        
        return { ok: true, data: response.data };
    } catch (error) {
        return { 
            ok: false, 
            error: error.response?.data || error.message,
            status: error.response?.status
        };
    }
}

async function sendText(remoteJid, text, clientMessageId) {
    const textWithId = text + '\u200B[#cmid:' + clientMessageId + ']';
    
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: textWithId
    };
    
    return await sendToEvolution(null, '/message/sendText', payload);
}

async function sendImage(remoteJid, imageUrl, caption, clientMessageId) {
    const captionWithId = caption ? caption + '\u200B[#cmid:' + clientMessageId + ']' : '\u200B[#cmid:' + clientMessageId + ']';
    
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediaMessage: {
            mediatype: 'image',
            media: imageUrl,
            caption: captionWithId
        }
    };
    
    return await sendToEvolution(null, '/message/sendMedia', payload);
}

async function sendVideo(remoteJid, videoUrl, caption, clientMessageId) {
    const captionWithId = caption ? caption + '\u200B[#cmid:' + clientMessageId + ']' : '\u200B[#cmid:' + clientMessageId + ']';
    
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediaMessage: {
            mediatype: 'video',
            media: videoUrl,
            caption: captionWithId
        }
    };
    
    return await sendToEvolution(null, '/message/sendVideo', payload);
}

// ============ ENVIO COM FALLBACK ============

async function sendWithFallback(remoteJid, type, text, mediaUrl) {
    const clientMessageId = uuidv4();
    
    const stickyInstance = stickyInstances.get(remoteJid);
    let instancesToTry = [...INSTANCES];
    
    if (stickyInstance) {
        instancesToTry = [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)];
    }
    
    let lastError = null;
    
    for (const instanceName of instancesToTry) {
        try {
            addLog('SEND_ATTEMPT', 'Tentando ' + instanceName + ' para ' + remoteJid, { type, clientMessageId });
            
            let result;
            
            if (type === 'text') {
                result = await sendText(remoteJid, text, clientMessageId);
            } else if (type === 'image') {
                result = await sendImage(remoteJid, mediaUrl, text, clientMessageId);
            } else if (type === 'video') {
                result = await sendVideo(remoteJid, mediaUrl, text, clientMessageId);
            } else if (type === 'image+text') {
                result = await sendImage(remoteJid, mediaUrl, text, clientMessageId);
            } else if (type === 'video+text') {
                result = await sendVideo(remoteJid, mediaUrl, text, clientMessageId);
            }
            
            if (result && result.ok) {
                stickyInstances.set(remoteJid, instanceName);
                return await waitForAck(clientMessageId, remoteJid, instanceName);
            } else {
                lastError = result.error;
                addLog('SEND_FAILED', instanceName + ' falhou: ' + lastError, { remoteJid, type });
            }
            
        } catch (error) {
            lastError = error.message;
            addLog('SEND_ERROR', instanceName + ' erro: ' + error.message, { remoteJid, type });
        }
    }
    
    addLog('SEND_ALL_FAILED', 'Todas as instâncias falharam para ' + remoteJid, { lastError });
    return { success: false, error: lastError };
}

async function waitForAck(clientMessageId, remoteJid, instanceName) {
    return new Promise((resolve) => {
        const ackData = {
            clientMessageId,
            remoteJid,
            instanceName,
            timestamp: Date.now(),
            resolve
        };
        
        pendingAcks.set(clientMessageId, ackData);
        
        setTimeout(() => {
            if (pendingAcks.has(clientMessageId)) {
                pendingAcks.delete(clientMessageId);
                addLog('ACK_TIMEOUT', 'Timeout de ACK para ' + clientMessageId, { remoteJid, instanceName });
                resolve({ success: false, error: 'ACK timeout' });
            }
        }, ACK_TIMEOUT_MS);
    });
}

// ============ ORQUESTRAÇÃO DE FUNIS ============

async function startFunnel(remoteJid, funnelId, orderCode, customerName, productType, amount) {
    const conversation = {
        remoteJid,
        funnelId,
        stepIndex: 0,
        orderCode,
        customerName,
        productType,
        amount,
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null
    };
    
    conversations.set(remoteJid, conversation);
    
    addLog('FUNNEL_START', 'Iniciando funil ' + funnelId + ' para ' + remoteJid, { orderCode, productType });
    
    await sendStep(remoteJid);
}

async function sendStep(remoteJid) {
    const conversation = conversations.get(remoteJid);
    if (!conversation) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;
    
    const idempotencyKey = 'SEND:' + remoteJid + ':' + conversation.funnelId + ':' + conversation.stepIndex;
    if (checkIdempotency(idempotencyKey)) {
        addLog('STEP_DUPLICATE', 'Passo duplicado ignorado: ' + conversation.funnelId + '[' + conversation.stepIndex + ']');
        return;
    }
    
    addLog('STEP_SEND', 'Enviando passo ' + conversation.stepIndex + ' do funil ' + conversation.funnelId, { step });
    
    const result = await sendWithFallback(
        remoteJid, 
        step.type, 
        step.text, 
        step.mediaUrl
    );
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply) {
            conversation.waiting_for_response = true;
            
            if (step.timeoutMinutes) {
                setTimeout(() => {
                    handleStepTimeout(remoteJid, conversation.stepIndex);
                }, step.timeoutMinutes * 60 * 1000);
            }
        } else {
            await advanceConversation(remoteJid, null, 'auto');
        }
        
        conversations.set(remoteJid, conversation);
        addLog('STEP_SUCCESS', 'Passo enviado com sucesso: ' + conversation.funnelId + '[' + conversation.stepIndex + ']');
    } else {
        addLog('STEP_FAILED', 'Falha no envio do passo: ' + result.error, { conversation });
    }
}

async function advanceConversation(remoteJid, replyText, reason) {
    const conversation = conversations.get(remoteJid);
    if (!conversation) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const currentStep = funnel.steps[conversation.stepIndex];
    if (!currentStep) return;
    
    let nextStepIndex;
    
    if (reason === 'reply' && currentStep.nextOnReply !== undefined) {
        nextStepIndex = currentStep.nextOnReply;
    } else if (reason === 'timeout' && currentStep.nextOnTimeout !== undefined) {
        nextStepIndex = currentStep.nextOnTimeout;
    } else {
        nextStepIndex = conversation.stepIndex + 1;
    }
    
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', 'Funil ' + conversation.funnelId + ' concluído para ' + remoteJid);
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    if (reason === 'reply') {
        conversation.lastReply = new Date();
    }
    
    conversations.set(remoteJid, conversation);
    
    addLog('STEP_ADVANCE', 'Avançando para passo ' + nextStepIndex + ' (motivo: ' + reason + ')', { conversation });
    
    await sendStep(remoteJid);
}

async function handleStepTimeout(remoteJid, expectedStepIndex) {
    const conversation = conversations.get(remoteJid);
    
    if (!conversation || 
        conversation.stepIndex !== expectedStepIndex || 
        !conversation.waiting_for_response) {
        return;
    }
    
    addLog('STEP_TIMEOUT', 'Timeout do passo ' + expectedStepIndex + ' para ' + remoteJid);
    await advanceConversation(remoteJid, null, 'timeout');
}

// ============ WEBHOOK KIRVANO ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        
        const event = String(data.event || '').toUpperCase();
        const status = String(data.status || data.payment_status || '').toUpperCase();
        const method = String(data.payment?.method || data.payment_method || '').toUpperCase();
        
        const saleId = data.sale_id || data.checkout_id;
        const orderCode = saleId || 'ORDER_' + Date.now();
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        const pixUrl = data.payment?.qrcode_image || data.payment?.qrcode || '';
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        
        if (!remoteJid || remoteJid === '@s.whatsapp.net') {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const idempotencyKey = 'KIRVANO:' + event + ':' + remoteJid + ':' + orderCode;
        if (checkIdempotency(idempotencyKey)) {
            return res.json({ success: true, message: 'Evento duplicado ignorado' });
        }
        
        let productType = 'UNKNOWN';
        if (data.products && data.products.length > 0) {
            const offerId = data.products[0].offer_id;
            productType = PRODUCT_MAPPING[offerId] || 'UNKNOWN';
        }
        
        addLog('KIRVANO_EVENT', event + ' - ' + productType + ' - ' + customerName, { orderCode, remoteJid });
        
        let funnelId;
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            const pixTimeout = pixTimeouts.get(remoteJid);
            if (pixTimeout) {
                clearTimeout(pixTimeout.timeout);
                pixTimeouts.delete(remoteJid);
                addLog('PIX_TIMEOUT_CANCELED', 'Timeout cancelado para ' + remoteJid, { orderCode });
            }
            
            funnelId = productType === 'FAB' ? 'FAB_APROVADA' : 'CS_APROVADA';
            
            await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
        } else if (isPix) {
            funnelId = productType === 'FAB' ? 'FAB_PIX' : 'CS_PIX';
            
            const existingTimeout = pixTimeouts.get(remoteJid);
            if (existingTimeout) {
                clearTimeout(existingTimeout.timeout);
            }
            
            await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
            const timeout = setTimeout(async () => {
                const conversation = conversations.get(remoteJid);
                if (conversation && conversation.orderCode === orderCode) {
                    const funnel = funis.get(conversation.funnelId);
                    if (funnel && funnel.steps[2]) {
                        conversation.stepIndex = 2;
                        conversation.waiting_for_response = false;
                        conversations.set(remoteJid, conversation);
                        await sendStep(remoteJid);
                    }
                }
                pixTimeouts.delete(remoteJid);
            }, PIX_TIMEOUT);
            
            pixTimeouts.set(remoteJid, {
                timeout,
                orderCode,
                createdAt: new Date()
            });
        }
        
        res.json({ success: true, message: 'Processado', funnelId });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ WEBHOOK EVOLUTION ============
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        
        if (fromMe) {
            const clientMessageIdMatch = messageText.match(/\[#cmid:([^\]]+)\]/);
            if (clientMessageIdMatch) {
                const clientMessageId = clientMessageIdMatch[1];
                const pendingAck = pendingAcks.get(clientMessageId);
                
                if (pendingAck) {
                    pendingAcks.delete(clientMessageId);
                    addLog('ACK_RECEIVED', 'ACK confirmado: ' + clientMessageId, { remoteJid });
                    pendingAck.resolve({ success: true, clientMessageId });
                }
            }
        } else {
            const conversation = conversations.get(remoteJid);
            
            if (conversation && conversation.waiting_for_response) {
                const idempotencyKey = 'REPLY:' + remoteJid + ':' + conversation.funnelId + ':' + conversation.stepIndex;
                if (checkIdempotency(idempotencyKey)) {
                    return res.json({ success: true, message: 'Resposta duplicada' });
                }
                
                addLog('CLIENT_REPLY', 'Resposta recebida de ' + remoteJid, { 
                    text: messageText.substring(0, 100),
                    step: conversation.stepIndex 
                });
                
                await advanceConversation(remoteJid, messageText, 'reply');
            }
        }
        
        res.json({ success: true });
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ENDPOINTS DE API ============

app.get('/status', (req, res) => {
    const activeConversations = Array.from(conversations.entries()).map(([remoteJid, conv]) => ({
        remoteJid,
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        productType: conv.productType,
        waiting_for_response: conv.waiting_for_response,
        createdAt: conv.createdAt,
        lastSystemMessage: conv.lastSystemMessage,
        lastReply: conv.lastReply,
        stickyInstance: stickyInstances.get(remoteJid)
    }));
    
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        stats: {
            active_conversations: conversations.size,
            pending_acks: pendingAcks.size,
            pending_pix: pixTimeouts.size,
            sticky_instances: stickyInstances.size,
            total_funnels: funis.size
        },
        conversations: activeConversations,
        recent_logs: logs.slice(0, 50)
    });
});

app.get('/funnels', (req, res) => {
    res.json(Array.from(funis.values()));
});

app.post('/funnels', (req, res) => {
    const funnel = req.body;
    
    if (!funnel.id || !funnel.name || !funnel.steps) {
        return res.status(400).json({ error: 'Dados inválidos' });
    }
    
    funis.set(funnel.id, funnel);
    addLog('FUNNEL_UPDATED', 'Funil ' + funnel.id + ' atualizado');
    
    res.json({ success: true, funnel });
});

app.delete('/funnels/:id', (req, res) => {
    const { id } = req.params;
    
    if (funis.has(id)) {
        funis.delete(id);
        addLog('FUNNEL_DELETED', 'Funil ' + id + ' removido');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Funil não encontrado' });
    }
});

app.get('/conversations', (req, res) => {
    const conversationsList = Array.from(conversations.entries()).map(([remoteJid, conv]) => ({
        remoteJid,
        phone: remoteJid.replace('@s.whatsapp.net', ''),
        ...conv,
        stickyInstance: stickyInstances.get(remoteJid)
    }));
    
    res.json(conversationsList);
});

app.post('/conversations/:remoteJid/advance', async (req, res) => {
    const { remoteJid } = req.params;
    const decodedJid = decodeURIComponent(remoteJid);
    
    const conversation = conversations.get(decodedJid);
    if (!conversation) {
        return res.status(404).json({ error: 'Conversa não encontrada' });
    }
    
    addLog('MANUAL_ADVANCE', 'Avançando conversa manualmente: ' + decodedJid);
    await advanceConversation(decodedJid, null, 'manual');
    
    res.json({ success: true });
});

app.post('/conversations/:remoteJid/reset', (req, res) => {
    const { remoteJid } = req.params;
    const decodedJid = decodeURIComponent(remoteJid);
    
    if (conversations.has(decodedJid)) {
        conversations.delete(decodedJid);
        stickyInstances.delete(decodedJid);
        addLog('CONVERSATION_RESET', 'Conversa resetada: ' + decodedJid);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Conversa não encontrada' });
    }
});

app.post('/send', async (req, res) => {
    const { remoteJid, type, text, mediaUrl } = req.body;
    
    if (!remoteJid || !type) {
        return res.status(400).json({ error: 'remoteJid e type são obrigatórios' });
    }
    
    addLog('MANUAL_SEND', 'Envio manual: ' + type + ' para ' + remoteJid);
    
    const result = await sendWithFallback(remoteJid, type, text, mediaUrl);
    
    res.json(result);
});

// ============ PAINEL WEB ============
app.get('/', (req, res) => {
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Kirvano - Sistema Online</title><style>body{font-family:Arial,sans-serif;margin:50px;background:#f5f5f5}h1{color:#333;text-align:center}</style></head><body><h1>🚀 Sistema Kirvano Online</h1><p>O sistema está funcionando corretamente!</p><p><strong>Endpoints disponíveis:</strong></p><ul><li>POST /webhook/kirvano - Recebe eventos do Kirvano</li><li>POST /webhook/evolution - Recebe eventos da Evolution</li><li>GET /status - Status do sistema</li><li>GET /funnels - Lista funis</li></ul></body></html>');
});

// ============ INICIALIZAÇÃO ============
app.listen(PORT, () => {
    console.log('Sistema Kirvano rodando na porta ' + PORT);
    console.log('Webhooks:');
    console.log('- Kirvano: /webhook/kirvano');
    console.log('- Evolution: /webhook/evolution');
    console.log('Status: /status');
    console.log('Funis configurados: ' + funis.size);
});
