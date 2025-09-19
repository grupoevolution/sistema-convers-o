const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const app = express();

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');

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
let idempotencyCache = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let logs = [];
let funis = new Map();

// ✅ FUNIS PADRÃO CORRIGIDOS - waitForReply false nos passos que devem continuar automaticamente
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
                waitForReply: false  // ✅ CORREÇÃO: false para continuar automaticamente
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Lembre-se de acessar nossa plataforma. Qualquer dúvida, estamos aqui!',
                waitForReply: false  // ✅ CORREÇÃO: false para continuar automaticamente
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
                waitForReply: false  // ✅ CORREÇÃO: false para continuar automaticamente
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'PIX vencido! Entre em contato conosco para gerar um novo.',
                waitForReply: false  // ✅ CORREÇÃO: false para continuar automaticamente
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
                waitForReply: false  // ✅ CORREÇÃO: false para continuar automaticamente
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Acesse nossa área de membros e comece sua transformação hoje mesmo!',
                waitForReply: false  // ✅ CORREÇÃO: false para continuar automaticamente
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
                waitForReply: false  // ✅ CORREÇÃO: false para continuar automaticamente
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'PIX vencido! Entre em contato para gerar um novo e não perder essa oportunidade.',
                waitForReply: false  // ✅ CORREÇÃO: false para continuar automaticamente
            }
        ]
    }
};

// ============ PERSISTÊNCIA DE DADOS ============

// Garantir que a pasta data existe
async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe ou erro ao criar:', error.message);
    }
}

// Salvar funis no arquivo
async function saveFunnelsToFile() {
    try {
        await ensureDataDir();
        const funnelsArray = Array.from(funis.values());
        await fs.writeFile(DATA_FILE, JSON.stringify(funnelsArray, null, 2));
        addLog('DATA_SAVE', 'Funis salvos em arquivo: ' + funnelsArray.length + ' funis');
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro ao salvar funis: ' + error.message);
    }
}

// Carregar funis do arquivo
async function loadFunnelsFromFile() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const funnelsArray = JSON.parse(data);
        
        // Limpar funis atuais e recarregar
        funis.clear();
        
        funnelsArray.forEach(funnel => {
            funis.set(funnel.id, funnel);
        });
        
        addLog('DATA_LOAD', 'Funis carregados do arquivo: ' + funnelsArray.length + ' funis');
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Erro ao carregar funis (usando padrões): ' + error.message);
        return false;
    }
}

// Salvar conversas ativas (para não perder o que está em andamento)
async function saveConversationsToFile() {
    try {
        await ensureDataDir();
        const conversationsArray = Array.from(conversations.entries()).map(([key, value]) => ({
            remoteJid: key,
            ...value,
            createdAt: value.createdAt.toISOString(),
            lastSystemMessage: value.lastSystemMessage ? value.lastSystemMessage.toISOString() : null,
            lastReply: value.lastReply ? value.lastReply.toISOString() : null
        }));
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({
            conversations: conversationsArray,
            stickyInstances: Array.from(stickyInstances.entries())
        }, null, 2));
        
        addLog('DATA_SAVE', 'Conversas salvas: ' + conversationsArray.length + ' conversas');
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro ao salvar conversas: ' + error.message);
    }
}

// Carregar conversas ativas
async function loadConversationsFromFile() {
    try {
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        
        // Recarregar conversas
        conversations.clear();
        parsed.conversations.forEach(conv => {
            const conversation = {
                ...conv,
                createdAt: new Date(conv.createdAt),
                lastSystemMessage: conv.lastSystemMessage ? new Date(conv.lastSystemMessage) : null,
                lastReply: conv.lastReply ? new Date(conv.lastReply) : null
            };
            conversations.set(conv.remoteJid, conversation);
        });
        
        // Recarregar sticky instances
        stickyInstances.clear();
        parsed.stickyInstances.forEach(([key, value]) => {
            stickyInstances.set(key, value);
        });
        
        addLog('DATA_LOAD', 'Conversas carregadas: ' + parsed.conversations.length + ' conversas');
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior encontrada: ' + error.message);
        return false;
    }
}

// Auto-save periódico (a cada 30 segundos)
setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
}, 30000);

// Inicializar funis padrão
Object.values(defaultFunnels).forEach(funnel => {
    funis.set(funnel.id, funnel);
});

// ============ MIDDLEWARES ============
app.use(express.json());
app.use(express.static('public')); // Serve arquivos estáticos da pasta public

// ============ FUNÇÕES AUXILIARES ============
function normalizePhone(phone) {
    if (!phone) return '';
    
    // Remove todos os caracteres não numéricos
    let cleaned = phone.replace(/\D/g, '');
    
    // Se começar com +55, remove o +
    if (cleaned.startsWith('55')) {
        cleaned = cleaned.substring(2);
    }
    
    // ✅ NORMALIZAÇÃO ROBUSTA PARA NÚMEROS BRASILEIROS
    
    // Se tem 10 dígitos (DDD + 8 dígitos), adicionar 9
    if (cleaned.length === 10) {
        const ddd = cleaned.substring(0, 2);
        const numero = cleaned.substring(2);
        cleaned = ddd + '9' + numero; // Adiciona o 9
    }
    
    // Se tem 11 dígitos mas não tem 9 após o DDD, adicionar
    if (cleaned.length === 11) {
        const ddd = cleaned.substring(0, 2);
        const primeiroDigito = cleaned.substring(2, 3);
        
        // Se o primeiro dígito após DDD não é 9, adicionar 9
        if (primeiroDigito !== '9') {
            const numero = cleaned.substring(2);
            cleaned = ddd + '9' + numero;
        }
    }
    
    // Garantir que tem exatamente 11 dígitos no final
    if (cleaned.length === 11) {
        cleaned = '55' + cleaned; // Adicionar código do país
    } else if (cleaned.length === 13 && cleaned.startsWith('55')) {
        // Já tem 55 + 11 dígitos, está correto
    } else {
        // Formato não reconhecido, tentar com código do país
        if (!cleaned.startsWith('55')) {
            cleaned = '55' + cleaned;
        }
    }
    
    addLog('PHONE_NORMALIZE', 'Número normalizado', { 
        input: phone, 
        output: cleaned,
        length: cleaned.length
    });
    
    return cleaned;
}

function phoneToRemoteJid(phone) {
    const normalized = normalizePhone(phone);
    return normalized + '@s.whatsapp.net';
}

// ✅ NOVA FUNÇÃO: Criar múltiplas variações do número para busca
function findConversationByPhone(phone) {
    const normalized = normalizePhone(phone);
    const remoteJid = normalized + '@s.whatsapp.net';
    
    // Tentar encontrar conversa com número exato
    if (conversations.has(remoteJid)) {
        addLog('CONVERSATION_FOUND_EXACT', 'Conversa encontrada com número exato', { remoteJid });
        return conversations.get(remoteJid);
    }
    
    // ✅ BUSCA FLEXÍVEL: Criar variações do número
    const phoneOnly = normalized.replace('55', ''); // Remove código do país
    const variations = [
        normalized + '@s.whatsapp.net',                    // 5575981734444@s.whatsapp.net
        '55' + phoneOnly + '@s.whatsapp.net',             // Com código país
        phoneOnly + '@s.whatsapp.net',                    // Sem código país: 75981734444@s.whatsapp.net
    ];
    
    // Se tem 11 dígitos, criar variação sem 9
    if (phoneOnly.length === 11 && phoneOnly.charAt(2) === '9') {
        const ddd = phoneOnly.substring(0, 2);
        const numeroSem9 = phoneOnly.substring(3);
        variations.push(ddd + numeroSem9 + '@s.whatsapp.net');           // 7581734444@s.whatsapp.net
        variations.push('55' + ddd + numeroSem9 + '@s.whatsapp.net');   // 557581734444@s.whatsapp.net
    }
    
    // Buscar em todas as variações
    for (const variation of variations) {
        if (conversations.has(variation)) {
            addLog('CONVERSATION_FOUND_VARIATION', 'Conversa encontrada com variação', { 
                searched: remoteJid,
                found: variation,
                variations: variations
            });
            
            // ✅ IMPORTANTE: Atualizar a chave da conversa para o formato normalizado
            const conversation = conversations.get(variation);
            conversations.delete(variation); // Remove entrada antiga
            conversations.set(remoteJid, conversation); // Adiciona com chave normalizada
            
            // Atualizar sticky instance também
            if (stickyInstances.has(variation)) {
                const instance = stickyInstances.get(variation);
                stickyInstances.delete(variation);
                stickyInstances.set(remoteJid, instance);
            }
            
            return conversation;
        }
    }
    
    addLog('CONVERSATION_NOT_FOUND', 'Nenhuma conversa encontrada', { 
        searched: remoteJid,
        variations: variations,
        existingConversations: Array.from(conversations.keys())
    });
    
    return null;
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
    if (idempotencyCache.has(key)) return true;
    idempotencyCache.set(key, now);
    return false;
}

function addLog(type, message, data = null) {
    const log = {
        id: Date.now() + Math.random(),
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

// ✅ CORREÇÃO 1: Remover códigos ID das mensagens
async function sendText(remoteJid, text, clientMessageId, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: text  // ✅ SEM adicionar código ID
    };
    return await sendToEvolution(instanceName, '/message/sendText', payload);
}

async function sendImage(remoteJid, imageUrl, caption, clientMessageId, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediaMessage: {
            mediatype: 'image',
            media: imageUrl,
            caption: caption || ''  // ✅ SEM adicionar código ID
        }
    };
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

async function sendVideo(remoteJid, videoUrl, caption, clientMessageId, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediaMessage: {
            mediatype: 'video',
            media: videoUrl,
            caption: caption || ''  // ✅ SEM adicionar código ID
        }
    };
    // ✅ CORREÇÃO 5: Usar endpoint correto para vídeo
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
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
                result = await sendText(remoteJid, text, clientMessageId, instanceName);
            } else if (type === 'image' || type === 'image+text') {
                result = await sendImage(remoteJid, mediaUrl, text, clientMessageId, instanceName);
            } else if (type === 'video' || type === 'video+text') {
                result = await sendVideo(remoteJid, mediaUrl, text, clientMessageId, instanceName);
            }
            
            if (result && result.ok) {
                stickyInstances.set(remoteJid, instanceName);
                // ✅ CORREÇÃO 2: Remover sistema de ACK que sempre dava timeout
                addLog('SEND_SUCCESS', 'Mensagem enviada com sucesso via ' + instanceName, { remoteJid, type });
                return { success: true, instanceName };
            } else {
                lastError = result.error;
                // ✅ CORREÇÃO 4: Melhorar logs de erro
                addLog('SEND_FAILED', instanceName + ' falhou: ' + JSON.stringify(lastError), { remoteJid, type });
            }
        } catch (error) {
            lastError = error.message;
            addLog('SEND_ERROR', instanceName + ' erro: ' + error.message, { remoteJid, type });
        }
    }
    
    addLog('SEND_ALL_FAILED', 'Todas as instâncias falharam para ' + remoteJid, { lastError });
    return { success: false, error: lastError };
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
    
    // DELAY ANTES (se configurado)
    if (step.delayBefore && step.delayBefore > 0) {
        addLog('STEP_DELAY', 'Aguardando ' + step.delayBefore + 's antes do passo ' + conversation.stepIndex);
        await new Promise(resolve => setTimeout(resolve, step.delayBefore * 1000));
    }
    
    // MOSTRAR DIGITANDO (se configurado)
    if (step.showTyping) {
        await sendTypingIndicator(remoteJid);
    }
    
    let result = { success: true };
    
    // PROCESSAR TIPO DO PASSO
    if (step.type === 'delay') {
        // Passo de delay puro
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', 'Executando delay de ' + delaySeconds + 's no passo ' + conversation.stepIndex);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        
    } else if (step.type === 'typing') {
        // Passo de digitando puro
        const typingSeconds = step.typingSeconds || 3;
        addLog('STEP_TYPING', 'Mostrando digitando por ' + typingSeconds + 's no passo ' + conversation.stepIndex);
        await sendTypingIndicator(remoteJid, typingSeconds);
        
    } else if (step.type === 'wait_reply') {
        // Passo de aguardar resposta (gatilho)
        addLog('STEP_WAIT_REPLY', 'Aguardando resposta do cliente no passo ' + conversation.stepIndex);
        conversation.waiting_for_response = true;
        
        // Configurar timeout se especificado
        if (step.timeoutMinutes) {
            setTimeout(() => {
                handleStepTimeout(remoteJid, conversation.stepIndex);
            }, step.timeoutMinutes * 60 * 1000);
        }
        
        // Para passos de aguardar resposta, não continuar automaticamente
        conversations.set(remoteJid, conversation);
        return;
        
    } else {
        // Passo de mensagem (texto, imagem, vídeo)
        result = await sendWithFallback(remoteJid, step.type, step.text, step.mediaUrl);
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        // ✅ CORREÇÃO CRÍTICA: Verificar waitForReply corretamente
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing' && step.type !== 'wait_reply') {
            // Aguardar resposta em mensagens normais
            conversation.waiting_for_response = true;
            addLog('STEP_WAITING_REPLY', 'Passo ' + conversation.stepIndex + ' aguardando resposta do cliente', { 
                funnelId: conversation.funnelId, 
                waitForReply: step.waitForReply,
                stepType: step.type
            });
            
            if (step.timeoutMinutes) {
                setTimeout(() => {
                    handleStepTimeout(remoteJid, conversation.stepIndex);
                }, step.timeoutMinutes * 60 * 1000);
            }
            
            // ✅ IMPORTANTE: Salvar estado antes de aguardar resposta
            conversations.set(remoteJid, conversation);
        } else {
            // ✅ CORREÇÃO: Avançar automaticamente quando waitForReply é false
            addLog('STEP_AUTO_ADVANCE', 'Passo ' + conversation.stepIndex + ' avançando automaticamente', { 
                funnelId: conversation.funnelId, 
                waitForReply: step.waitForReply,
                stepType: step.type
            });
            
            // Salvar estado atual antes de avançar
            conversations.set(remoteJid, conversation);
            
            // Avançar automaticamente para o próximo passo
            await advanceConversation(remoteJid, null, 'auto');
        }
        
        addLog('STEP_SUCCESS', 'Passo executado com sucesso: ' + conversation.funnelId + '[' + conversation.stepIndex + ']');
    } else {
        addLog('STEP_FAILED', 'Falha no envio do passo: ' + result.error, { conversation });
    }
}

// Enviar indicador de digitação
async function sendTypingIndicator(remoteJid, durationSeconds = 3) {
    const instanceName = stickyInstances.get(remoteJid) || INSTANCES[0];
    
    try {
        // Iniciar digitação
        await sendToEvolution(instanceName, '/chat/sendPresence', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            presence: 'composing'
        });
        
        addLog('TYPING_START', 'Iniciando digitação para ' + remoteJid + ' por ' + durationSeconds + 's');
        
        // Aguardar o tempo especificado
        await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
        
        // Parar digitação
        await sendToEvolution(instanceName, '/chat/sendPresence', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            presence: 'paused'
        });
        
        addLog('TYPING_END', 'Finalizando digitação para ' + remoteJid);
        
    } catch (error) {
        addLog('TYPING_ERROR', 'Erro ao enviar digitação: ' + error.message, { remoteJid });
    }
}

async function advanceConversation(remoteJid, replyText, reason) {
    const conversation = conversations.get(remoteJid);
    if (!conversation) {
        addLog('ADVANCE_ERROR', 'Tentativa de avançar conversa inexistente: ' + remoteJid);
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        addLog('ADVANCE_ERROR', 'Funil não encontrado: ' + conversation.funnelId, { remoteJid });
        return;
    }
    
    const currentStep = funnel.steps[conversation.stepIndex];
    if (!currentStep) {
        addLog('ADVANCE_ERROR', 'Passo atual não encontrado: ' + conversation.stepIndex, { 
            remoteJid, 
            funnelId: conversation.funnelId 
        });
        return;
    }
    
    // ✅ LOGS DETALHADOS para debug
    addLog('ADVANCE_START', 'Iniciando avanço da conversa', {
        remoteJid: remoteJid,
        currentStep: conversation.stepIndex,
        funnelId: conversation.funnelId,
        reason: reason,
        currentStepType: currentStep.type,
        waitingForResponse: conversation.waiting_for_response,
        nextOnReply: currentStep.nextOnReply,
        nextOnTimeout: currentStep.nextOnTimeout
    });
    
    let nextStepIndex;
    if (reason === 'reply' && currentStep.nextOnReply !== undefined) {
        nextStepIndex = currentStep.nextOnReply;
        addLog('ADVANCE_LOGIC', 'Usando nextOnReply: ' + nextStepIndex, { reason, currentStep: conversation.stepIndex });
    } else if (reason === 'timeout' && currentStep.nextOnTimeout !== undefined) {
        nextStepIndex = currentStep.nextOnTimeout;
        addLog('ADVANCE_LOGIC', 'Usando nextOnTimeout: ' + nextStepIndex, { reason, currentStep: conversation.stepIndex });
    } else {
        nextStepIndex = conversation.stepIndex + 1;
        addLog('ADVANCE_LOGIC', 'Usando próximo sequencial: ' + nextStepIndex, { reason, currentStep: conversation.stepIndex });
    }
    
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', 'Funil ' + conversation.funnelId + ' concluído para ' + remoteJid, {
            totalSteps: funnel.steps.length,
            finalStep: conversation.stepIndex
        });
        
        // ✅ Marcar conversa como finalizada mas manter no registro
        conversation.waiting_for_response = false;
        conversation.completed = true;
        conversation.completedAt = new Date();
        conversations.set(remoteJid, conversation);
        return;
    }
    
    // ✅ Atualizar conversa
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    if (reason === 'reply') {
        conversation.lastReply = new Date();
    }
    
    conversations.set(remoteJid, conversation);
    
    addLog('STEP_ADVANCE', 'Avançando para passo ' + nextStepIndex + ' (motivo: ' + reason + ')', { 
        remoteJid,
        funnelId: conversation.funnelId,
        previousStep: conversation.stepIndex - 1,
        nextStep: nextStepIndex,
        reason: reason
    });
    
    // ✅ Enviar próximo passo
    await sendStep(remoteJid);
}

async function handleStepTimeout(remoteJid, expectedStepIndex) {
    const conversation = conversations.get(remoteJid);
    if (!conversation || conversation.stepIndex !== expectedStepIndex || !conversation.waiting_for_response) {
        return;
    }
    addLog('STEP_TIMEOUT', 'Timeout do passo ' + expectedStepIndex + ' para ' + remoteJid);
    await advanceConversation(remoteJid, null, 'timeout');
}

// ============ WEBHOOKS ============
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
            
            pixTimeouts.set(remoteJid, { timeout, orderCode, createdAt: new Date() });
        }
        
        res.json({ success: true, message: 'Processado', funnelId });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ✅ CORREÇÃO 3: Adicionar logs detalhados no webhook Evolution
app.post('/webhook/evolution', async (req, res) => {
    // ✅ Log completo do webhook recebido
    console.log('===== WEBHOOK EVOLUTION RECEBIDO =====');
    console.log(JSON.stringify(req.body, null, 2));
    addLog('WEBHOOK_RECEIVED', 'Webhook Evolution recebido', req.body);
    
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            addLog('WEBHOOK_IGNORED', 'Webhook sem dados de mensagem');
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        
        addLog('WEBHOOK_DETAILS', 'Processando mensagem', { 
            remoteJid, 
            fromMe, 
            messageText: messageText.substring(0, 100),
            hasConversation: conversations.has(remoteJid)
        });
        
        // ✅ CORREÇÃO 6: Remover lógica de ACK que não funciona mais
        if (fromMe) {
            addLog('WEBHOOK_FROM_ME', 'Mensagem enviada por nós ignorada', { remoteJid });
            return res.json({ success: true });
        } else {
            const incomingPhone = messageData.key.remoteJid.replace('@s.whatsapp.net', '');
            
            // ✅ CORREÇÃO: Usar busca flexível por telefone
            const conversation = findConversationByPhone(incomingPhone);
            
            if (conversation && conversation.waiting_for_response) {
                const normalizedRemoteJid = normalizePhone(incomingPhone) + '@s.whatsapp.net';
                
                const idempotencyKey = 'REPLY:' + normalizedRemoteJid + ':' + conversation.funnelId + ':' + conversation.stepIndex;
                if (checkIdempotency(idempotencyKey)) {
                    addLog('WEBHOOK_DUPLICATE_REPLY', 'Resposta duplicada ignorada', { remoteJid: normalizedRemoteJid });
                    return res.json({ success: true, message: 'Resposta duplicada' });
                }
                
                addLog('CLIENT_REPLY', 'Resposta recebida e processada', { 
                    originalRemoteJid: remoteJid,
                    normalizedRemoteJid: normalizedRemoteJid,
                    text: messageText.substring(0, 100),
                    step: conversation.stepIndex,
                    funnelId: conversation.funnelId
                });
                
                await advanceConversation(normalizedRemoteJid, messageText, 'reply');
            } else {
                addLog('WEBHOOK_NO_CONVERSATION', 'Mensagem recebida mas sem conversa ativa', { 
                    remoteJid, 
                    incomingPhone,
                    normalizedPhone: normalizePhone(incomingPhone),
                    messageText: messageText.substring(0, 50),
                    existingConversations: Array.from(conversations.keys()).slice(0, 3)
                });
            }
        }
        
        res.json({ success: true });
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ENDPOINTS ============

// Dashboard - estatísticas principais
app.get('/api/dashboard', (req, res) => {
    const stats = {
        active_conversations: conversations.size,
        pending_pix: pixTimeouts.size,
        total_funnels: funis.size,
        total_instances: INSTANCES.length,
        sticky_instances: stickyInstances.size
    };
    
    res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
    });
});

// Funis - CRUD completo
app.get('/api/funnels', (req, res) => {
    const funnelsList = Array.from(funis.values()).map(funnel => ({
        ...funnel,
        isDefault: funnel.id.includes('_APROVADA') || funnel.id.includes('_PIX'),
        stepCount: funnel.steps.length
    }));
    
    res.json({
        success: true,
        data: funnelsList
    });
});

app.post('/api/funnels', (req, res) => {
    const funnel = req.body;
    
    if (!funnel.id || !funnel.name || !funnel.steps) {
        return res.status(400).json({ 
            success: false, 
            error: 'ID, nome e passos são obrigatórios' 
        });
    }
    
    funis.set(funnel.id, funnel);
    addLog('FUNNEL_SAVED', 'Funil salvo: ' + funnel.id);
    
    // Salvar imediatamente no arquivo
    saveFunnelsToFile();
    
    res.json({ 
        success: true, 
        message: 'Funil salvo com sucesso',
        data: funnel
    });
});

app.delete('/api/funnels/:id', (req, res) => {
    const { id } = req.params;
    
    // Proteger funis padrão
    if (id.includes('_APROVADA') || id.includes('_PIX')) {
        return res.status(400).json({ 
            success: false, 
            error: 'Não é possível excluir funis padrão' 
        });
    }
    
    if (funis.has(id)) {
        funis.delete(id);
        addLog('FUNNEL_DELETED', 'Funil excluído: ' + id);
        
        // Salvar imediatamente no arquivo
        saveFunnelsToFile();
        
        res.json({ success: true, message: 'Funil excluído com sucesso' });
    } else {
        res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
});

// Conversas/Envios
app.get('/api/conversations', (req, res) => {
    const conversationsList = Array.from(conversations.entries()).map(([remoteJid, conv]) => ({
        id: remoteJid,
        phone: remoteJid.replace('@s.whatsapp.net', ''),
        customerName: conv.customerName,
        productType: conv.productType,
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        createdAt: conv.createdAt,
        lastSystemMessage: conv.lastSystemMessage,
        lastReply: conv.lastReply,
        orderCode: conv.orderCode,
        amount: conv.amount,
        stickyInstance: stickyInstances.get(remoteJid)
    }));
    
    // Ordenar por mais recente primeiro
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({
        success: true,
        data: conversationsList
    });
});

// Logs recentes
app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const recentLogs = logs.slice(0, limit).map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        message: log.message
    }));
    
    res.json({
        success: true,
        data: recentLogs
    });
});

// Teste de envio
app.post('/api/send-test', async (req, res) => {
    const { remoteJid, type, text, mediaUrl } = req.body;
    
    if (!remoteJid || !type) {
        return res.status(400).json({ 
            success: false, 
            error: 'remoteJid e type são obrigatórios' 
        });
    }
    
    addLog('TEST_SEND', 'Teste de envio: ' + type + ' para ' + remoteJid);
    
    const result = await sendWithFallback(remoteJid, type, text, mediaUrl);
    
    if (result.success) {
        res.json({ 
            success: true, 
            message: 'Mensagem enviada com sucesso!',
            instanceUsed: result.instanceName
        });
    } else {
        res.status(500).json({ success: false, error: result.error });
    }
});

// Debug da Evolution API
app.get('/api/debug/evolution', async (req, res) => {
    const debugInfo = {
        evolution_base_url: EVOLUTION_BASE_URL,
        evolution_api_key_configured: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI',
        evolution_api_key_length: EVOLUTION_API_KEY.length,
        instances: INSTANCES,
        active_conversations: conversations.size,
        sticky_instances_count: stickyInstances.size,
        test_results: []
    };
    
    // Testar conexão com primeiro endpoint
    try {
        const testInstance = INSTANCES[0];
        const url = EVOLUTION_BASE_URL + '/message/sendText/' + testInstance;
        
        const response = await axios.post(url, {
            number: '5511999999999',
            text: 'teste'
        }, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 10000,
            validateStatus: () => true // Aceitar qualquer status para debug
        });
        
        debugInfo.test_results.push({
            instance: testInstance,
            url: url,
            status: response.status,
            response: response.data,
            headers: response.headers
        });
        
    } catch (error) {
        debugInfo.test_results.push({
            instance: INSTANCES[0],
            error: error.message,
            code: error.code
        });
    }
    
    res.json(debugInfo);
});

// ============ SERVIR FRONTEND ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicialização - carregar dados persistidos
async function initializeData() {
    console.log('🔄 Carregando dados persistidos...');
    
    const funnelsLoaded = await loadFunnelsFromFile();
    if (!funnelsLoaded) {
        console.log('📋 Usando funis padrão');
    }
    
    const conversationsLoaded = await loadConversationsFromFile();
    if (!conversationsLoaded) {
        console.log('💬 Nenhuma conversa anterior encontrada');
    }
    
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis carregados:', funis.size);
    console.log('💬 Conversas ativas:', conversations.size);
}

// ============ INICIALIZAÇÃO ============
app.listen(PORT, async () => {
    console.log('='.repeat(60));
    console.log('🚀 KIRVANO SYSTEM - BACKEND API [VERSÃO TOTALMENTE CORRIGIDA]');
    console.log('='.repeat(60));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('API Key configurada:', EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI');
    console.log('Instâncias:', INSTANCES.length);
    console.log('');
    console.log('🔧 TODAS AS CORREÇÕES APLICADAS + CORREÇÃO CRÍTICA:');
    console.log('  ✅ 1. Códigos ID removidos das mensagens');
    console.log('  ✅ 2. Sistema de ACK removido (não mais timeout)');  
    console.log('  ✅ 3. Logs detalhados do webhook Evolution');
    console.log('  ✅ 4. Logs de erro melhorados (JSON stringify)');
    console.log('  ✅ 5. Endpoint de vídeo corrigido (/sendMedia)');
    console.log('  ✅ 6. Limpeza: funções e variáveis ACK removidas');
    console.log('  ✅ 7. CRÍTICA: Lógica waitForReply corrigida');
    console.log('  ✅ 8. CRÍTICA: Logs detalhados em advanceConversation');
    console.log('  ✅ 9. CRÍTICA: Funis padrão com waitForReply correto');
    console.log('  ✅ 10. CRÍTICA: Normalização robusta de telefones');
    console.log('  ✅ 11. CRÍTICA: Busca flexível de conversas por telefone');
    console.log('');
    console.log('🎯 RESULTADO ESPERADO:');
    console.log('  • Mensagens limpas (sem códigos visíveis)');
    console.log('  • Funil continua automaticamente');
    console.log('  • Fallback entre instâncias funcionando');
    console.log('  • Respostas dos clientes detectadas');
    console.log('');
    console.log('📡 API Endpoints:');
    console.log('  GET  /api/dashboard     - Estatísticas');
    console.log('  GET  /api/funnels       - Listar funis');
    console.log('  POST /api/funnels       - Criar/editar funil');
    console.log('  GET  /api/conversations  - Listar conversas');
    console.log('  GET  /api/logs          - Logs recentes');
    console.log('  POST /api/send-test     - Teste de envio');
    console.log('  GET  /api/debug/evolution - Debug Evolution API');
    console.log('');
    console.log('📨 Webhooks:');
    console.log('  POST /webhook/kirvano   - Eventos Kirvano');
    console.log('  POST /webhook/evolution - Eventos Evolution');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('🧪 Testes: http://localhost:' + PORT + '/test.html');
    console.log('='.repeat(60));
    
    // Carregar dados persistidos
    await initializeData();
});
