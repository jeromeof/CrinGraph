//
// Copyright 2024 : Pragmatic Audio
//
// Define the shared logic for JadeAudio / FiiO devices - Each manufacturer will have slightly
// different code so best to each have a separate 'module'

const PEQ_FILTER_COUNT = 24;
const PEQ_GLOBAL_GAIN = 23;
const PEQ_FILTER_PARAMS = 21;
const PEQ_PRESET_SWITCH = 22;
const PEQ_SAVE_TO_DEVICE = 25;
const PEQ_RESET_DEVICE = 27;
const PEQ_RESET_ALL = 28;
// Note these have different headers
const PEQ_FIRMWARE_VERSION = 11;
const PEQ_NAME_DEVICE = 48;

const SET_HEADER1 = 0xAA;
const SET_HEADER2 = 0x0A;
const GET_HEADER1 = 0xBB;
const GET_HEADER2 = 0x0B;
const END_HEADERS = 0xEE;

const fiioUsbHID = {
    connect: async function(device) {
        try {
            if (!device.opened) {
                await device.open();
            }
            console.log("FiiO Device connected");
        } catch (error) {
            console.error("Failed to connect to FiiO Device:", error);
            throw error;
        }
    },
    getCurrentSlot: async function(device) {
        try {
            let currentSlot = -99;

            device.oninputreport = async (event) => {
                const data = new Uint8Array(event.data.buffer);
                if (data[0] === GET_HEADER1 && data[1] === GET_HEADER2) {
                    switch (data[4]) {
                        case PEQ_PRESET_SWITCH:
                            currentSlot = handleEqPreset(data, device);
                            break;
                        default:
                            console.log("Unhandled data type:", data[4]);
                    }
                }
            };

            await getPresetPeq(device);

            // Wait at most 10 seconds for filters to be populated
            const result = await waitForFilters(() => { return currentSlot > -99}, device, 10000, (device) => (
                currentSlot
            ));

            return result;
        } catch (error) {
            console.error("Failed to pull data from FiiO Device:", error);
            throw error;
        }
    },

    pushToDevice: async function(device, slot, preamp_gain, filters) {
        try {
            // FiiO devices will automatically cut the maxGain (typically -12)
            // But we can safely apply a +12 gain - the preamp_gain needed
            await setGlobalGain(device, getModelConfig(device).maxGain - preamp_gain);
            const maxFilters = getModelConfig(device).maxFilters;
            const maxFiltersToUse = Math.min(filters.length, maxFilters);
            await setPeqCounter(device, maxFiltersToUse);

            for (let filterIdx = 0; filterIdx < maxFiltersToUse; filterIdx++) {
                const filter = filters[filterIdx];
                await setPeqParams(device, filterIdx, filter.freq, filter.gain, filter.q, convertFromFilterType(filter.type));
            }

            saveToDevice(device, slot);

            console.log("PEQ filters pushed successfully.");

            if (getModelConfig(device).disconnectOnSave) {
                return true;    // Disconnect
            }
            return false;

        } catch (error) {
            console.error("Failed to push data to FiiO Device:", error);
            throw error;
        }
    },

    pullFromDevice: async function(device, slot) {
        try {
            const filters = [];
            let peqCount = 0;
            let globalGain = 0;
            let currentSlot = 0;

            device.oninputreport = async (event) => {
                const data = new Uint8Array(event.data.buffer);
                if (data[0] === GET_HEADER1 && data[1] === GET_HEADER2) {
                    switch (data[4]) {
                        case PEQ_FILTER_COUNT:
                            peqCount = handlePeqCounter(data, device);
                            break;
                        case PEQ_FILTER_PARAMS:
                            handlePeqParams(data, device, filters);
                            break;
                        case PEQ_GLOBAL_GAIN:
                            globalGain = handleGain(data[6], data[7]);
                            break;
                        case PEQ_PRESET_SWITCH:
                            currentSlot = handleEqPreset(data, device);
                            break;
                        case PEQ_SAVE_TO_DEVICE:
                            savedEQ(data, device);
                            break;
                        default:
                            console.log("Unhandled data type:", data[4]);
                    }
                }
            };

            await getPresetPeq(device);
            await getPeqCounter(device);
            await getGlobalGain(device);

            // Wait at most 10 seconds for filters to be populated
            const result = await waitForFilters(() => { return filters.length == peqCount}, device, 10000, (device) => ({
                filters: filters,
                globalGain: globalGain,
                currentSlot: currentSlot,
                deviceDetails: getModelConfig(device)
            }));

            return result;
        } catch (error) {
            console.error("Failed to pull data from FiiO Device:", error);
            throw error;
        }
    },

    enablePEQ: async function(device, enable, slotId) {
        var deviceModel = getModelConfig(device);

        if (enable) {   // take the slotId we are given and switch to it
            await setPresetPeq(device, slotId);
        } else {
            await setPresetPeq(device, deviceModel.maxFilters);
        }
    }
};

// Helper Functions

async function setPeqParams(device, filterIndex, fc, gain, q, filterType) {
    const [frequencyLow, frequencyHigh] = splitUnsignedValue(fc);
    const [gainLow, gainHigh] = fiioGainBytesFromValue(gain);
    const qFactorValue = Math.round(q * 100);
    const [qFactorLow, qFactorHigh] = splitUnsignedValue(qFactorValue);

    const packet = [
        SET_HEADER1, SET_HEADER2, 0, 0, PEQ_FILTER_PARAMS, 8,
        filterIndex, gainLow, gainHigh,
        frequencyLow, frequencyHigh,
        qFactorLow, qFactorHigh,
        filterType, 0, END_HEADERS
    ];

    const data = new Uint8Array(packet);
    const reportId = device.collections[0].outputReports[0].reportId;
    await device.sendReport(reportId, data);
}

async function setPresetPeq(device, presetId ) { // Default to 0 if not specified
    const packet = [
        SET_HEADER1, SET_HEADER2, 0, 0, PEQ_PRESET_SWITCH, 1,
        presetId, 0, END_HEADERS
    ];

    const data = new Uint8Array(packet);
    const reportId = device.collections[0].outputReports[0].reportId;
    await device.sendReport(reportId, data);
}

async function setGlobalGain(device, gain) {
    const globalGain = Math.round(gain * 10) ;
    const gainBytes = toBytePair(globalGain);

    const packet = [
        SET_HEADER1, SET_HEADER2, 0, 0, PEQ_GLOBAL_GAIN, 2,
        gainBytes[1], gainBytes[0], 0, END_HEADERS
    ];

    const data = new Uint8Array(packet);
    const reportId = device.collections[0].outputReports[0].reportId;
    await device.sendReport(reportId, data);
}

async function setPeqCounter(device, counter) {
    const packet = [
        SET_HEADER1, SET_HEADER2, 0, 0, PEQ_FILTER_COUNT, 1,
        counter, 0, END_HEADERS
    ];

    const data = new Uint8Array(packet);
    const reportId = device.collections[0].outputReports[0].reportId;
    await device.sendReport(reportId, data);
}

function convertFromFilterType(filterType) {
    const mapping = { "PK": 0, "LSQ": 1, "HSQ": 2 };
    return mapping[filterType] !== undefined ? mapping[filterType] : 0;
}

function convertToFilterType(datum) {
    switch (datum) {
        case 0:
            return "PK";
        case 1:
            return "LSQ";
        case 2:
            return "HSQ";
        default:
            return "PK";
    }
}

function toBytePair(value) {
    return [
        value & 0xFF,
        (value & 0xFF00) >> 8
    ];
}

function splitSignedValue(value) {
    const signedValue = value < 0 ? value + 65536 : value;
    return [
        (signedValue >> 8) & 0xFF,
        signedValue & 0xFF
    ];
}

function splitUnsignedValue(value) {
    return [
        (value >> 8) & 0xFF,
        value & 0xFF
    ];
}

function combineBytes(lowByte, highByte) {
    return (lowByte << 8) | highByte;
}

function getGlobalGain(device) {
    const packet = [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_GLOBAL_GAIN, 0, 0, END_HEADERS];
    const data = new Uint8Array(packet);
    console.log("getGlobalGain() Send data:", data);
    const reportId = device.collections[0].outputReports[0].reportId;
    device.sendReport(reportId, data);
}

function getPeqCounter(device) {
    const packet = [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_FILTER_COUNT, 0, 0, END_HEADERS];
    const data = new Uint8Array(packet);
    console.log("getPeqCounter() Send data:", data);
    const reportId = device.collections[0].outputReports[0].reportId;
    device.sendReport(reportId, data);
}

function getPeqParams(device, filterIndex) {
    const packet = [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_FILTER_PARAMS, 1, filterIndex, 0, END_HEADERS];
    const data = new Uint8Array(packet);
    console.log("getPeqParams() Send data:", data);
    const reportId = device.collections[0].outputReports[0].reportId;
    device.sendReport(reportId, data);
}

function getPresetPeq(device) {
    const packet = [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_PRESET_SWITCH, 0, 0, END_HEADERS];
    const data = new Uint8Array(packet);
    console.log("getPresetPeq() Send data:", data);
    const reportId = device.collections[0].outputReports[0].reportId;
    device.sendReport(reportId, data);
}
function saveToDevice(device, slotId) {
    const packet = [SET_HEADER1, SET_HEADER2, 0, 0, PEQ_SAVE_TO_DEVICE, 1, slotId, 0, END_HEADERS];
    const data = new Uint8Array(packet);
    console.log("saveToDevice() reportId Send data:", data);
    const reportId = device.collections[0].outputReports[0].reportId;
    device.sendReport(reportId, data);
}

function handlePeqCounter(data, device) {
    peqCount = data[6];
    console.log("***********oninputreport peq counter=", peqCount);
    if (peqCount > 0) {
        processPeqCount(device);
    }
    return peqCount;
}

function processPeqCount(device) {
    console.log("PEQ Counter:", peqCount);

    // Fetch individual PEQ settings based on count
    for (let i = 0; i < peqCount; i++) {
        getPeqParams(device, i);
    }
}

function handlePeqParams(data, device, filters) {
    const filter = data[6];
    const gain = handleGain(data[7], data[8]);
    const frequency = combineBytes(data[9], data[10]);
    const qFactor = (combineBytes(data[11],data[12])) / 100 || 1;
    const filterType = convertToFilterType(data[13]);

    console.log(`Filter ${filter}: Gain=${gain}, Frequency=${frequency}, Q=${qFactor}, Type=${filterType}`);

    filters[filter] = {
        type: filterType,
        freq: frequency,
        q: qFactor,
        gain: gain,
        disabled: false
    };
}


function handleGain(lowByte, highByte) {
    let r = combineBytes(lowByte, highByte);
    const gain =  r & 32768 ? (r = (r ^ 65535) + 1, -r / 10) : r / 10;
    return gain;
}

function fiioGainBytesFromValue( e ) {
    let t = e * 10;
    t < 0 && (t = (Math.abs(t) ^ 65535) + 1);
    const r = t >> 8 & 255,
        n = t & 255;
    return [r, n]
}

function handleEqPreset(data, device) {
    const presetId = data[6];
    console.log("EQ Preset ID:", presetId);

    if (presetId > getModelConfig(device).availableSlots.length) {
        return -1;      // with JA11 slot 4 == Off
    }
    // Handle preset switch if necessary
    return presetId;
}

function savedEQ(data, device) {
    const slotId = data[6];
    console.log("EQ Slot ID:", slotId);
    // Handle slot enablement if necessary
}

function getModelConfig(device) {
    const configuration = modelConfiguration[device.productName];
    return configuration || modelConfiguration["default"];
}

const modelConfiguration = {
    "default": { minGain: -12, maxGain: 12, maxFilters: 5, firstWritableEQSlot: -1, maxWritableEQSlots: 0, disconnectOnSave: true, availableSlots:[] },
    "FIIO KA17": { minGain: -12, maxGain: 12, maxFilters: 10, firstWritableEQSlot: 7, maxWritableEQSlots: 3, disconnectOnSave: false, availableSlots:[{id:0,name:"Jazz"}, {id:1,name:"Pop"}, {id:2,name:"Rock"}, {id:3,name:"Dance"}, {id:5,name:"R&B"}, {id:6,name:"Classic"},{id:7,name:"Hip-hop"},  {id:4,name:"USER1"}, {id:8,name:"USER2"}, {id:9,name:"USER3"}] },
    "JadeAudio JA11": { minGain: -12, maxGain: 12, maxFilters: 5, firstWritableEQSlot: 3, maxWritableEQSlots: 1, disconnectOnSave: true, availableSlots:[{id:0,name:"Vocal"}, {id:1,name:"Classic"}, {id:2,name:"Bass"}, {id:3,name:"USER1"}] },
    "FIIO LS-TC2": { minGain: -12, maxGain: 12, maxFilters: 5, firstWritableEQSlot: 3, maxWritableEQSlots: 1, disconnectOnSave: true, availableSlots:[{id:0,name:"Vocal"}, {id:1,name:"Classic"}, {id:2,name:"Bass"}, {id:3,name:"Dance"}, {id:4,name:"R&B"}, {id:5,name:"Classic"},{id:6,name:"Hip-hop"}, {id:160,name:"USER1"}] },
    "FIIO RETRO NANO": { minGain: -12, maxGain: 12, maxFilters: 5, firstWritableEQSlot: 3, maxWritableEQSlots: 1, disconnectOnSave: true, availableSlots:[{id:0,name:"Vocal"}, {id:1,name:"Classic"}, {id:2,name:"Bass"}, {id:3,name:"Dance"}, {id:4,name:"R&B"}, {id:5,name:"Classic"},{id:6,name:"Hip-hop"}, {id:160,name:"USER1"}, {id:161,name:"USER2"}, {id:162,name:"USER3"}] },
    "FIIO BTR13": { minGain: -12, maxGain: 12, maxFilters: 10, firstWritableEQSlot: 7, maxWritableEQSlots: 3 , disconnectOnSave: false, availableSlots:[{id:0,name:"Jazz"}, {id:1,name:"Pop"}, {id:2,name:"Rock"}, {id:3,name:"Dance"}, {id:4,name:"R&B"}, {id:5,name:"Classic"},{id:6,name:"Hip-hop"}, {id:7,name:"USER1"}, {id:8,name:"USER2"}, {id:9,name:"USER3"}]},
    "FIIO BTR17": { minGain: -12, maxGain: 12, maxFilters: 10, firstWritableEQSlot: 7, maxWritableEQSlots: 3 , disconnectOnSave: false, availableSlots:[{id:0,name:"Jazz"}, {id:1,name:"Pop"}, {id:2,name:"Rock"}, {id:3,name:"Dance"}, {id:4,name:"R&B"}, {id:5,name:"Classic"},{id:6,name:"Hip-hop"}, {id: 160, name: "USER1"}, {id:161,name:"USER2"}, {id:162,name:"USER3"} , {id: 160, name: "USER1"}, {id:161,name:"USER2"}, {id:162,name:"USER3"}, {id: 163, name: "USER4"}, {id:164,name:"USER5"}, {id:165,name:"USER6"}, {id: 166, name: "USER7"}, {id:167,name:"USER8"}, {id:168,name:"USER9"}, {id:169,name:"USER10"}]},
    "FIIO KA15": { minGain: -12, maxGain: 12, maxFilters: 10, firstWritableEQSlot: 7, maxWritableEQSlots: 3, disconnectOnSave: false, availableSlots:[{id:0,name:"Jazz"}, {id:1,name:"Pop"}, {id:2,name:"Rock"}, {id:3,name:"Dance"}, {id:4,name:"R&B"}, {id:5,name:"Classic"},{id:6,name:"Hip-hop"}, {id:7,name:"USER1"}, {id:8,name:"USER2"}, {id:9,name:"USER3"}] }
};

// Utility function to wait for a condition or timeout
function waitForFilters(condition, device, timeout, callback) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (!condition()) {
                console.warn("Timeout reached before data returned?");
                reject(callback(device));
            } else {
                resolve(callback(device));
            }
        }, timeout);

        // Check every 100 milliseconds if everything is ready based on condition method !!
        const interval = setInterval(() => {
            if (condition()) {
                clearTimeout(timer);
                clearInterval(interval);
                resolve(callback(device));
            }
        }, 100);
    });
}

// Export fiioUsbHID for use in Node.js or other modules
if (typeof window !== 'undefined') {
    window.fiioUsbHID = fiioUsbHID;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = fiioUsbHID;
}
