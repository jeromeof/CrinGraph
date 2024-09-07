//
// Copyright 2024 : Pragmatic Audio
//
// Declare UsbHIDConnector and attach it to the global window object
window.UsbHIDConnector = (function() {

    let config = {
    };


    let devices = [];

    let deviceHandlers = {
        "FiiO": {
            "JadeAudio JA11": fiioUsbHID,
            "FiiO KA17":     fiioUsbHID,
        }
        // Add more manufacturers and models here
    };

    let isWebHIDSupported = function () {
        return 'hid' in navigator;
    };


    let getDeviceConnected = async function() {
        try {
            const filters = [
                {"vendorId": 10610, "manufacturer":"FiiO", "productNames":["JadeAudio JA11"]}  // FiiO - add more when I get more examples
            ];

            // Check if the device is already connected
            let existingDevice = devices.find(d => d.rawDevice.vendorId === filters[0].vendorId);
            if (existingDevice) {
                console.log("Device already connected:", existingDevice.model);
                return existingDevice;
            }

            // Request devices matching the filters
            const selectedDevices = await navigator.hid.requestDevice({ filters });

            if (selectedDevices.length > 0) {
                // Select the first device and store it as the current device
                const rawDevice = selectedDevices[0];

                const manufacturer = filters[0].manufacturer;
                const model = rawDevice.productName;    // Model == productName

                console.log("Manufacturer:", manufacturer);
                console.log("Model:", model);

                // Open the device if it's not already open
                if (!rawDevice.opened) {
                    await rawDevice.open()
                } else {
                    console.log("Device is already open:", currentDevice.model);
                }
                let currentDevice = {
                    "rawDevice": rawDevice,
                    "manufacturer": manufacturer,
                    "model": model
                }

                // Store the device with its identified handler
                devices.push(currentDevice);

                return currentDevice;
            } else {
                console.log("No device found.");
            }
        } catch (error) {
            console.error("Failed to connect to HID device:", error);

        }
    };

    let connectToDevice = async function(device) {
        const handler = getDeviceHandler(device);
        if (!handler) {
            console.error("Device handler not found for", device.manufacturerName, device.productName);
            return;
        }
        await handler.connect(device.rawDevice);
    };

    let pushToDevice = async function(device, slot, preamp, fr) {
        const handler = getDeviceHandler(device);
        if (!handler) {
            console.error("Device handler not found for", device.manufacturerName, device.productName);
            return;
        }
        await handler.pushToDevice(device.rawDevice, slot, preamp, fr);
    };

    let pullFromDevice = async function(device, slot) {
        const handler = getDeviceHandler(device);
        if (!handler) {
            console.error("Device handler not found for", device.manufacturerName, device.productName);
            return;
        }
        return await handler.pullFromDevice(device.rawDevice, slot);
    };

    let getDeviceHandler = function(device) {
        const manufacturer = device.manufacturer;
        const model = device.model;
        return deviceHandlers[manufacturer]?.[model];
    };


    return {
        config,
        isWebHIDSupported,
        getDeviceConnected,
        connectToDevice,
        pushToDevice,
        pullFromDevice
    }
})();
