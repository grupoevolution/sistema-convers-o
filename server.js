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
let conversations = new Map();       // remoteJid -> conversationState
let pendingAcks = new Map();        // clientMessageId -> ackData
let idempotencyCache = new Map();   // cache de idempotência
let stickyInstances = new Map();    // remoteJid -> instanceName
let pixTimeouts = new Map();        // remoteJid -> timeoutData
let logs = [];                      // histórico de eventos
let funis = new Map();             // funnelId -> funnel

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
    
    // Limpar cache antigo
    for (const [k, timestamp] of idempotencyCache.entries()) {
        if (now - timestamp > ttl) {
            idempotencyCache.delete(k);
        }
    }
    
    if (idempotencyCache.has(key)) {
        return true; // duplicado
    }
    
    idempotencyCache.set(key, now);
    return false; // novo
}

function addLog(type, message, data = null) {
    const log = {
        timestamp: new Date(),
        type,
        message,
        data
    };
    
    logs.unshift(log);
    
    // Manter apenas últimos 1000 logs
    if (logs.length > 1000) {
        logs = logs.slice(0, 1000);
    }
    
    console.log(`[${log.timestamp.toISOString()}] ${type}: ${message}`);
}

// ============ EVOLUTION API ADAPTER ============

async function sendToEvolution(instanceName, endpoint, payload) {
    const url = `${EVOLUTION_BASE_URL}${endpoint}/${instanceName}`;
    
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
    // Adicionar marcador invisível no texto
    const textWithId = text + `\u200B[#cmid:${clientMessageId}]`;
    
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: textWithId
    };
    
    return await sendToEvolution(null, '/message/sendText', payload);
}

async function sendImage(remoteJid, imageUrl, caption, clientMessageId) {
    const captionWithId = caption ? caption + `\u200B[#cmid:${clientMessageId}]` : `\u200B[#cmid:${clientMessageId}]`;
    
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
    const captionWithId = caption ? caption + `\u200B[#cmid:${clientMessageId}]` : `\u200B[#cmid:${clientMessageId}]`;
    
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
    
    // Verificar se existe instância sticky
    const stickyInstance = stickyInstances.get(remoteJid);
    let instancesToTry = [...INSTANCES];
    
    if (stickyInstance) {
        // Colocar sticky na frente da lista
        instancesToTry = [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)];
    }
    
    let lastError = null;
    
    for (const instanceName of instancesToTry) {
        try {
            addLog('SEND_ATTEMPT', `Tentando ${instanceName} para ${remoteJid}`, { type, clientMessageId });
            
            let result;
            
            if (type === 'text') {
                result = await sendText(remoteJid, text, clientMessageId);
            } else if (type === 'image') {
                result = await sendImage(remoteJid, mediaUrl, text, clientMessageId);
            } else if (type === 'video') {
                result = await sendVideo(remoteJid, videoUrl, text, clientMessageId);
            } else if (type === 'image+text') {
                result = await sendImage(remoteJid, mediaUrl, text, clientMessageId);
            } else if (type === 'video+text') {
                result = await sendVideo(remoteJid, mediaUrl, text, clientMessageId);
            }
            
            if (result && result.ok) {
                // Sucesso! Salvar instância sticky e aguardar ACK
                stickyInstances.set(remoteJid, instanceName);
                
                // Aguardar confirmação via webhook
                return await waitForAck(clientMessageId, remoteJid, instanceName);
            } else {
                lastError = result.error;
                addLog('SEND_FAILED', `${instanceName} falhou: ${lastError}`, { remoteJid, type });
            }
            
        } catch (error) {
            lastError = error.message;
            addLog('SEND_ERROR', `${instanceName} erro: ${error.message}`, { remoteJid, type });
        }
    }
    
    // Todas as instâncias falharam
    addLog('SEND_ALL_FAILED', `Todas as instâncias falharam para ${remoteJid}`, { lastError });
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
        
        // Timeout para ACK
        setTimeout(() => {
            if (pendingAcks.has(clientMessageId)) {
                pendingAcks.delete(clientMessageId);
                addLog('ACK_TIMEOUT', `Timeout de ACK para ${clientMessageId}`, { remoteJid, instanceName });
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
    
    addLog('FUNNEL_START', `Iniciando funil ${funnelId} para ${remoteJid}`, { orderCode, productType });
    
    await sendStep(remoteJid);
}

async function sendStep(remoteJid) {
    const conversation = conversations.get(remoteJid);
    if (!conversation) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;
    
    // Verificar idempotência
    const idempotencyKey = `SEND:${remoteJid}:${conversation.funnelId}:${conversation.stepIndex}`;
    if (checkIdempotency(idempotencyKey)) {
        addLog('STEP_DUPLICATE', `Passo duplicado ignorado: ${conversation.funnelId}[${conversation.stepIndex}]`);
        return;
    }
    
    addLog('STEP_SEND', `Enviando passo ${conversation.stepIndex} do funil ${conversation.funnelId}`, { step });
    
    // Enviar mensagem
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
            
            // Configurar timeout se especificado
            if (step.timeoutMinutes) {
                setTimeout(() => {
                    handleStepTimeout(remoteJid, conversation.stepIndex);
                }, step.timeoutMinutes * 60 * 1000);
            }
        } else {
            // Avançar automaticamente para o próximo passo
            await advanceConversation(remoteJid, null, 'auto');
        }
        
        conversations.set(remoteJid, conversation);
        addLog('STEP_SUCCESS', `Passo enviado com sucesso: ${conversation.funnelId}[${conversation.stepIndex}]`);
    } else {
        addLog('STEP_FAILED', `Falha no envio do passo: ${result.error}`, { conversation });
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
        // Próximo passo sequencial
        nextStepIndex = conversation.stepIndex + 1;
    }
    
    // Verificar se existe o próximo passo
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', `Funil ${conversation.funnelId} concluído para ${remoteJid}`);
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    if (reason === 'reply') {
        conversation.lastReply = new Date();
    }
    
    conversations.set(remoteJid, conversation);
    
    addLog('STEP_ADVANCE', `Avançando para passo ${nextStepIndex} (motivo: ${reason})`, { conversation });
    
    // Enviar próximo passo
    await sendStep(remoteJid);
}

async function handleStepTimeout(remoteJid, expectedStepIndex) {
    const conversation = conversations.get(remoteJid);
    
    if (!conversation || 
        conversation.stepIndex !== expectedStepIndex || 
        !conversation.waiting_for_response) {
        return; // Conversa mudou ou não está mais aguardando
    }
    
    addLog('STEP_TIMEOUT', `Timeout do passo ${expectedStepIndex} para ${remoteJid}`);
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
        const orderCode = saleId || `ORDER_${Date.now()}`;
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        const pixUrl = data.payment?.qrcode_image || data.payment?.qrcode || '';
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        
        if (!remoteJid || remoteJid === '@s.whatsapp.net') {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        // Verificar idempotência
        const idempotencyKey = `KIRVANO:${event}:${remoteJid}:${orderCode}`;
        if (checkIdempotency(idempotencyKey)) {
            return res.json({ success: true, message: 'Evento duplicado ignorado' });
        }
        
        // Identificar produto
        let productType = 'UNKNOWN';
        if (data.products && data.products.length > 0) {
            const offerId = data.products[0].offer_id;
            productType = PRODUCT_MAPPING[offerId] || 'UNKNOWN';
        }
        
        addLog('KIRVANO_EVENT', `${event} - ${productType} - ${customerName}`, { orderCode, remoteJid });
        
        // Determinar qual funil usar
        let funnelId;
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            // Cancelar timeout de PIX se existir
            const pixTimeout = pixTimeouts.get(remoteJid);
            if (pixTimeout) {
                clearTimeout(pixTimeout.timeout);
                pixTimeouts.delete(remoteJid);
                addLog('PIX_TIMEOUT_CANCELED', `Timeout cancelado para ${remoteJid}`, { orderCode });
            }
            
            funnelId = productType === 'FAB' ? 'FAB_APROVADA' : 'CS_APROVADA';
            
            await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
        } else if (isPix) {
            funnelId = productType === 'FAB' ? 'FAB_PIX' : 'CS_PIX';
            
            // Cancelar timeout anterior se existir
            const existingTimeout = pixTimeouts.get(remoteJid);
            if (existingTimeout) {
                clearTimeout(existingTimeout.timeout);
            }
            
            // Iniciar funil imediatamente
            await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
            // Configurar timeout de 7 minutos para PIX
            const timeout = setTimeout(async () => {
                const conversation = conversations.get(remoteJid);
                if (conversation && conversation.orderCode === orderCode) {
                    // Forçar ir para o passo de timeout (geralmente step 2)
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
            // Verificar se é confirmação (ACK) de mensagem nossa
            const clientMessageIdMatch = messageText.match(/\[#cmid:([^\]]+)\]/);
            if (clientMessageIdMatch) {
                const clientMessageId = clientMessageIdMatch[1];
                const pendingAck = pendingAcks.get(clientMessageId);
                
                if (pendingAck) {
                    pendingAcks.delete(clientMessageId);
                    addLog('ACK_RECEIVED', `ACK confirmado: ${clientMessageId}`, { remoteJid });
                    pendingAck.resolve({ success: true, clientMessageId });
                }
            }
        } else {
            // Resposta do cliente
            const conversation = conversations.get(remoteJid);
            
            if (conversation && conversation.waiting_for_response) {
                // Verificar idempotência
                const idempotencyKey = `REPLY:${remoteJid}:${conversation.funnelId}:${conversation.stepIndex}`;
                if (checkIdempotency(idempotencyKey)) {
                    return res.json({ success: true, message: 'Resposta duplicada' });
                }
                
                addLog('CLIENT_REPLY', `Resposta recebida de ${remoteJid}`, { 
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

// Status
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

// Funis
app.get('/funnels', (req, res) => {
    res.json(Array.from(funis.values()));
});

app.post('/funnels', (req, res) => {
    const funnel = req.body;
    
    if (!funnel.id || !funnel.name || !funnel.steps) {
        return res.status(400).json({ error: 'Dados inválidos' });
    }
    
    funis.set(funnel.id, funnel);
    addLog('FUNNEL_UPDATED', `Funil ${funnel.id} atualizado`);
    
    res.json({ success: true, funnel });
});

app.delete('/funnels/:id', (req, res) => {
    const { id } = req.params;
    
    if (funis.has(id)) {
        funis.delete(id);
        addLog('FUNNEL_DELETED', `Funil ${id} removido`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Funil não encontrado' });
    }
});

// Conversas
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
    
    addLog('MANUAL_ADVANCE', `Avançando conversa manualmente: ${decodedJid}`);
    await advanceConversation(decodedJid, null, 'manual');
    
    res.json({ success: true });
});

app.post('/conversations/:remoteJid/reset', (req, res) => {
    const { remoteJid } = req.params;
    const decodedJid = decodeURIComponent(remoteJid);
    
    if (conversations.has(decodedJid)) {
        conversations.delete(decodedJid);
        stickyInstances.delete(decodedJid);
        addLog('CONVERSATION_RESET', `Conversa resetada: ${decodedJid}`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Conversa não encontrada' });
    }
});

// Envio manual
app.post('/send', async (req, res) => {
    const { remoteJid, type, text, mediaUrl } = req.body;
    
    if (!remoteJid || !type) {
        return res.status(400).json({ error: 'remoteJid e type são obrigatórios' });
    }
    
    addLog('MANUAL_SEND', `Envio manual: ${type} para ${remoteJid}`);
    
    const result = await sendWithFallback(remoteJid, type, text, mediaUrl);
    
    res.json(result);
});

// ============ PAINEL WEB ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kirvano - Painel de Controle</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: #333;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        
        .header {
            background: white;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 24px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
        }
        
        h1 {
            color: #333;
            margin-bottom: 8px;
            font-size: 28px;
        }
        
        .subtitle {
            color: #666;
            margin-bottom: 20px;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 20px;
        }
        
        .stat-card {
            background: #f8f9fa;
            padding: 16px;
            border-radius: 8px;
            border-left: 4px solid #667eea;
        }
        
        .stat-value {
            font-size: 24px;
            font-weight: bold;
            color: #333;
        }
        
        .stat-label {
            color: #666;
            font-size: 14px;
            margin-top: 4px;
        }
        
        .content {
            background: white;
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
        }
        
        .tabs {
            display: flex;
            border-bottom: 2px solid #f0f0f0;
            margin-bottom: 24px;
        }
        
        .tab {
            padding: 12px 20px;
            background: none;
            border: none;
            cursor: pointer;
            color: #666;
            border-bottom: 2px solid transparent;
            margin-bottom: -2px;
        }
        
        .tab.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 16px;
        }
        
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #eee;
        }
        
        th {
            background: #f8f9fa;
            font-weight: 600;
            color: #555;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
        }
        
        .badge-success { background: #d4edda; color: #155724; }
        .badge-warning { background: #fff3cd; color: #856404; }
        .badge-info { background: #d1ecf1; color: #0c5460; }
        .badge-danger { background: #f8d7da; color: #721c24; }
        
        .btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            margin: 0 4px;
            font-size: 14px;
        }
        
        .btn:hover {
            background: #5a67d8;
        }
        
        .btn-small {
            padding: 4px 8px;
            font-size: 12px;
        }
        
        .form-group {
            margin-bottom: 16px;
        }
        
        label {
            display: block;
            margin-bottom: 4px;
            font-weight: 500;
        }
        
        input, textarea, select {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
        }
        
        .step-item {
            background: #f8f9fa;
            border: 1px solid #e9ecef;
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 12px;
        }
        
        .step-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        
        .log-item {
            background: #f8f9fa;
            padding: 12px;
            border-left: 4px solid #667eea;
            margin-bottom: 8px;
            font-family: monospace;
            font-size: 13px;
        }
        
        .log-error { border-left-color: #dc3545; }
        .log-success { border-left-color: #28a745; }
        
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: #666;
        }
        
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 1000;
        }
        
        .modal-content {
            background: white;
            margin: 50px auto;
            padding: 24px;
            border-radius: 8px;
            width: 90%;
            max-width: 600px;
            max-height: 80vh;
            overflow-y: auto;
        }
        
        .close {
            float: right;
            font-size: 24px;
            cursor: pointer;
            color: #999;
        }
        
        .close:hover {
            color: #333;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Kirvano - Painel de Controle</h1>
            <p class="subtitle">Sistema de funis e fallback para Evolution API</p>
            
            <div class="stats" id="stats">
                <div class="stat-card">
                    <div class="stat-value" id="activeConversations">-</div>
                    <div class="stat-label">Conversas Ativas</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="pendingAcks">-</div>
                    <div class="stat-label">ACKs Pendentes</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="pendingPix">-</div>
                    <div class="stat-label">PIX Pendentes</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="totalFunnels">-</div>
                    <div class="stat-label">Funis Configurados</div>
                </div>
            </div>
            
            <button class="btn" onclick="refreshData()">Atualizar</button>
        </div>
        
        <div class="content">
            <div class="tabs">
                <button class="tab active" onclick="switchTab('conversations')">Conversas</button>
                <button class="tab" onclick="switchTab('funnels')">Funis</button>
                <button class="tab" onclick="switchTab('logs')">Logs</button>
                <button class="tab" onclick="switchTab('debug')">Debug</button>
            </div>
            
            <div id="conversations" class="tab-content active">
                <div id="conversationsContent">Carregando...</div>
            </div>
            
            <div id="funnels" class="tab-content">
                <div style="margin-bottom: 16px;">
                    <button class="btn" onclick="showFunnelModal()">Novo Funil</button>
                </div>
                <div id="funnelsContent">Carregando...</div>
            </div>
            
            <div id="logs" class="tab-content">
                <div id="logsContent">Carregando...</div>
            </div>
            
            <div id="debug" class="tab-content">
                <h3>Envio Manual</h3>
                <div class="form-group">
                    <label>Telefone (remoteJid)</label>
                    <input type="text" id="debugPhone" placeholder="5511999999999@s.whatsapp.net">
                </div>
                <div class="form-group">
                    <label>Tipo</label>
                    <select id="debugType">
                        <option value="text">Texto</option>
                        <option value="image">Imagem</option>
                        <option value="video">Vídeo</option>
                        <option value="image+text">Imagem + Texto</option>
                        <option value="video+text">Vídeo + Texto</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Texto</label>
                    <textarea id="debugText" rows="3"></textarea>
                </div>
                <div class="form-group">
                    <label>URL da Mídia</label>
                    <input type="text" id="debugMediaUrl">
                </div>
                <button class="btn" onclick="sendDebugMessage()">Enviar</button>
            </div>
        </div>
    </div>
    
    <!-- Modal para edição de funil -->
    <div id="funnelModal" class="modal">
        <div class="modal-content">
            <span class="close" onclick="closeFunnelModal()">&times;</span>
            <h3 id="modalTitle">Editar Funil</h3>
            
            <div class="form-group">
                <label>ID do Funil</label>
                <input type="text" id="funnelId">
            </div>
            
            <div class="form-group">
                <label>Nome do Funil</label>
                <input type="text" id="funnelName">
            </div>
            
            <h4>Passos</h4>
            <div id="stepsContainer"></div>
            
            <button class="btn" onclick="addStep()">Adicionar Passo</button>
            <button class="btn" onclick="saveFunnel()">Salvar Funil</button>
        </div>
    </div>
    
    <script>
        let currentData = {};
        let currentFunnel = null;
        
        async function refreshData() {
            try {
                const [statusResponse, funnelsResponse] = await Promise.all([
                    fetch('/status'),
                    fetch('/funnels')
                ]);
                
                const statusData = await statusResponse.json();
                const funnelsData = await funnelsResponse.json();
                
                currentData = { ...statusData, funnels: funnelsData };
                
                updateStats();
                updateActiveTab();
            } catch (error) {
                console.error('Erro ao carregar dados:', error);
            }
        }
        
        function updateStats() {
            document.getElementById('activeConversations').textContent = currentData.stats?.active_conversations || 0;
            document.getElementById('pendingAcks').textContent = currentData.stats?.pending_acks || 0;
            document.getElementById('pendingPix').textContent = currentData.stats?.pending_pix || 0;
            document.getElementById('totalFunnels').textContent = currentData.stats?.total_funnels || 0;
        }
        
        function switchTab(tabName) {
            // Atualizar tabs
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabName).classList.add('active');
            
            updateActiveTab();
        }
        
        function updateActiveTab() {
            const activeTab = document.querySelector('.tab.active').textContent.toLowerCase();
            
            if (activeTab === 'conversas') {
                updateConversationsTab();
            } else if (activeTab === 'funis') {
                updateFunnelsTab();
            } else if (activeTab === 'logs') {
                updateLogsTab();
            }
        }
        
        function updateConversationsTab() {
            const content = document.getElementById('conversationsContent');
            const conversations = currentData.conversations || [];
            
            if (conversations.length === 0) {
                content.innerHTML = '<div class="empty-state">Nenhuma conversa ativa</div>';
                return;
            }
            
            let html = '<table><thead><tr><th>Telefone</th><th>Produto</th><th>Funil</th><th>Passo</th><th>Status</th><th>Instância</th><th>Ações</th></tr></thead><tbody>';
            
            conversations.forEach(conv => {
                const phone = conv.phone || conv.remoteJid.replace('@s.whatsapp.net', '');
                const statusBadge = conv.waiting_for_response ? 
                    '<span class="badge badge-warning">Aguardando</span>' : 
                    '<span class="badge badge-success">Pronto</span>';
                
                html += `<tr>
                    <td>${phone}</td>
                    <td><span class="badge badge-info">${conv.productType}</span></td>
                    <td>${conv.funnelId}</td>
                    <td>${conv.stepIndex}</td>
                    <td>${statusBadge}</td>
                    <td>${conv.stickyInstance || '-'}</td>
                    <td>
                        <button class="btn btn-small" onclick="advanceConversation('${encodeURIComponent(conv.remoteJid)}')">Avançar</button>
                        <button class="btn btn-small" onclick="resetConversation('${encodeURIComponent(conv.remoteJid)}')">Reset</button>
                    </td>
                </tr>`;
            });
            
            html += '</tbody></table>';
            content.innerHTML = html;
        }
        
        function updateFunnelsTab() {
            const content = document.getElementById('funnelsContent');
            const funnels = currentData.funnels || [];
            
            if (funnels.length === 0) {
                content.innerHTML = '<div class="empty-state">Nenhum funil configurado</div>';
                return;
            }
            
            let html = '';
            funnels.forEach(funnel => {
                html += `
                    <div class="step-item">
                        <div class="step-header">
                            <h4>${funnel.name} (${funnel.id})</h4>
                            <div>
                                <button class="btn btn-small" onclick="editFunnel('${funnel.id}')">Editar</button>
                                <button class="btn btn-small" onclick="deleteFunnel('${funnel.id}')">Excluir</button>
                            </div>
                        </div>
                        <p><strong>Passos:</strong> ${funnel.steps.length}</p>
                    </div>
                `;
            });
            
            content.innerHTML = html;
        }
        
        function updateLogsTab() {
            const content = document.getElementById('logsContent');
            const logs = currentData.recent_logs || [];
            
            if (logs.length === 0) {
                content.innerHTML = '<div class="empty-state">Nenhum log recente</div>';
                return;
            }
            
            let html = '';
            logs.forEach(log => {
                const timestamp = new Date(log.timestamp).toLocaleTimeString();
                const className = log.type.includes('ERROR') ? 'log-error' : 
                                log.type.includes('SUCCESS') ? 'log-success' : '';
                
                html += `
                    <div class="log-item ${className}">
                        <strong>${timestamp}</strong> [${log.type}] ${log.message}
                    </div>
                `;
            });
            
            content.innerHTML = html;
        }
        
        async function advanceConversation(remoteJid) {
            try {
                await fetch(`/conversations/${remoteJid}/advance`, { method: 'POST' });
                refreshData();
            } catch (error) {
                alert('Erro ao avançar conversa');
            }
        }
        
        async function resetConversation(remoteJid) {
            if (!confirm('Tem certeza que deseja resetar esta conversa?')) return;
            
            try {
                await fetch(`/conversations/${remoteJid}/reset`, { method: 'POST' });
                refreshData();
            } catch (error) {
                alert('Erro ao resetar conversa');
            }
        }
        
        function showFunnelModal(funnelId = null) {
            currentFunnel = funnelId ? currentData.funnels.find(f => f.id === funnelId) : null;
            
            document.getElementById('modalTitle').textContent = funnelId ? 'Editar Funil' : 'Novo Funil';
            document.getElementById('funnelId').value = currentFunnel?.id || '';
            document.getElementById('funnelName').value = currentFunnel?.name || '';
            
            renderSteps();
            document.getElementById('funnelModal').style.display = 'block';
        }
        
        function closeFunnelModal() {
            document.getElementById('funnelModal').style.display = 'none';
        }
        
        function editFunnel(funnelId) {
            showFunnelModal(funnelId);
        }
        
        async function deleteFunnel(funnelId) {
            if (!confirm('Tem certeza que deseja excluir este funil?')) return;
            
            try {
                await fetch(`/funnels/${funnelId}`, { method: 'DELETE' });
                refreshData();
            } catch (error) {
                alert('Erro ao excluir funil');
            }
        }
        
        function renderSteps() {
            const container = document.getElementById('stepsContainer');
            const steps = currentFunnel?.steps || [];
            
            let html = '';
            steps.forEach((step, index) => {
                html += `
                    <div class="step-item">
                        <div class="step-header">
                            <h5>Passo ${index}</h5>
                            <button class="btn btn-small" onclick="removeStep(${index})">Remover</button>
                        </div>
                        
                        <div class="form-group">
                            <label>Tipo</label>
                            <select onchange="updateStep(${index}, 'type', this.value)">
                                <option value="text" ${step.type === 'text' ? 'selected' : ''}>Texto</option>
                                <option value="image" ${step.type === 'image' ? 'selected' : ''}>Imagem</option>
                                <option value="video" ${step.type === 'video' ? 'selected' : ''}>Vídeo</option>
                                <option value="image+text" ${step.type === 'image+text' ? 'selected' : ''}>Imagem + Texto</option>
                                <option value="video+text" ${step.type === 'video+text' ? 'selected' : ''}>Vídeo + Texto</option>
                            </select>
                        </div>
                        
                        <div class="form-group">
                            <label>Texto</label>
                            <textarea rows="2" onchange="updateStep(${index}, 'text', this.value)">${step.text || ''}</textarea>
                        </div>
                        
                        <div class="form-group">
                            <label>URL da Mídia</label>
                            <input type="text" value="${step.mediaUrl || ''}" onchange="updateStep(${index}, 'mediaUrl', this.value)">
                        </div>
                        
                        <div class="form-group">
                            <label>
                                <input type="checkbox" ${step.waitForReply ? 'checked' : ''} onchange="updateStep(${index}, 'waitForReply', this.checked)">
                                Aguardar Resposta
                            </label>
                        </div>
                        
                        <div class="form-group">
                            <label>Timeout (minutos)</label>
                            <input type="number" value="${step.timeoutMinutes || ''}" onchange="updateStep(${index}, 'timeoutMinutes', parseInt(this.value) || undefined)">
                        </div>
                        
                        <div class="form-group">
                            <label>Próximo passo na resposta</label>
                            <input type="number" value="${step.nextOnReply || ''}" onchange="updateStep(${index}, 'nextOnReply', parseInt(this.value) || undefined)">
                        </div>
                        
                        <div class="form-group">
                            <label>Próximo passo no timeout</label>
                            <input type="number" value="${step.nextOnTimeout || ''}" onchange="updateStep(${index}, 'nextOnTimeout', parseInt(this.value) || undefined)">
                        </div>
                    </div>
                `;
            });
            
            container.innerHTML = html;
        }
        
        function addStep() {
            if (!currentFunnel) {
                currentFunnel = { id: '', name: '', steps: [] };
            }
            
            currentFunnel.steps.push({
                id: `step_${currentFunnel.steps.length + 1}`,
                type: 'text',
                text: '',
                waitForReply: false
            });
            
            renderSteps();
        }
        
        function removeStep(index) {
            if (!currentFunnel) return;
            currentFunnel.steps.splice(index, 1);
            renderSteps();
        }
        
        function updateStep(index, field, value) {
            if (!currentFunnel) return;
            currentFunnel.steps[index][field] = value;
        }
        
        async function saveFunnel() {
            const id = document.getElementById('funnelId').value;
            const name = document.getElementById('funnelName').value;
            
            if (!id || !name) {
                alert('ID e Nome são obrigatórios');
                return;
            }
            
            const funnel = {
                id,
                name,
                steps: currentFunnel?.steps || []
            };
            
            try {
                await fetch('/funnels', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(funnel)
                });
                
                closeFunnelModal();
                refreshData();
            } catch (error) {
                alert('Erro ao salvar funil');
            }
        }
        
        async function sendDebugMessage() {
            const remoteJid = document.getElementById('debugPhone').value;
            const type = document.getElementById('debugType').value;
            const text = document.getElementById('debugText').value;
            const mediaUrl = document.getElementById('debugMediaUrl').value;
            
            if (!remoteJid || !type) {
                alert('Telefone e tipo são obrigatórios');
                return;
            }
            
            try {
                const response = await fetch('/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ remoteJid, type, text, mediaUrl })
                });
                
                const result = await response.json();
                alert(result.success ? 'Mensagem enviada!' : 'Erro: ' + result.error);
            } catch (error) {
                alert('Erro ao enviar mensagem');
            }
        }
        
        // Auto refresh
        setInterval(refreshData, 5000);
        refreshData();
    </script>
</body>
</html>
    `);
});

// ============ INICIALIZAÇÃO ============
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  KIRVANO - SISTEMA DE FUNIS               ║
╚═══════════════════════════════════════════════════════════╝

🚀 Servidor rodando na porta ${PORT}
🔗 Painel: http://localhost:${PORT}

📡 ENDPOINTS DISPONÍVEIS:
   • POST /webhook/kirvano    - Recebe eventos do Kirvano
   • POST /webhook/evolution  - Recebe eventos da Evolution
   • GET  /status            - Status do sistema
   • GET  /funnels           - Lista funis
   • POST /funnels           - Cria/atualiza funil
   • DELETE /funnels/:id     - Remove funil
   • GET  /conversations     - Lista conversas
   • POST /send             - Envio manual

🎯 FUNCIONALIDADES ATIVAS:
   ✓ Fallback sequencial GABY01→GABY09
   ✓ ACK via webhook (fromMe=true)
   ✓ Funis com passos configuráveis
   ✓ PIX timeout de 7 minutos
   ✓ Sticky instances por cliente
   ✓ Painel web completo
   ✓ Idempotência em todos os fluxos

🔧 CONFIGURAÇÃO:
   • Evolution: ${EVOLUTION_BASE_URL}
   • ACK Timeout: ${ACK_TIMEOUT_MS}ms
   • Instâncias: ${INSTANCES.length}
   • Produtos: CS, FAB
   • Funis padrão: 4 configurados

═══════════════════════════════════════════════════════════════
    `);
});
