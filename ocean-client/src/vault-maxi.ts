import { MainNet } from '@defichain/jellyfish-network'
import { LoanVaultActive, LoanVaultState, LoanVaultTokenAmount } from '@defichain/whale-api-client/dist/api/loan'
import { PoolPairData } from '@defichain/whale-api-client/dist/api/poolpairs'
import { ActivePrice } from '@defichain/whale-api-client/dist/api/prices'
import { VaultMaxiProgram } from './programs/vault-maxi-program'
import { Logger } from './utils/logger'
import { Store, StoredSettings } from './utils/store'
import { Telegram } from './utils/telegram'
import { WalletSetup } from './utils/wallet-setup'
import { BigNumber } from "@defichain/jellyfish-api-core";
import { TokenBalance } from '@defichain/jellyfish-transaction/dist'
import { CheckProgram } from './programs/check-program'


class SettingsOverride {
    minCollateralRatio: number | undefined
    maxCollateralRatio: number | undefined
    LMToken: string | undefined
}

class maxiEvent {
    overrideSettings: SettingsOverride | undefined
    checkSetup: boolean | undefined
}

export async function main(event: maxiEvent): Promise<Object> {
    let settings = await new Store().fetchSettings()
    console.log("vault maxi v1.0-beta.1")
    const telegram = new Telegram(settings, "[Maxi" + settings.paramPostFix + " " + (settings.vault?.length > 6 ? settings.vault.substring(0, 6) : "...") + "]")
    if (event) {
        console.log("received event " + JSON.stringify(event))
        if (event.overrideSettings) {
            if (event.overrideSettings.maxCollateralRatio)
                settings.maxCollateralRatio = event.overrideSettings.maxCollateralRatio
            if (event.overrideSettings.minCollateralRatio)
                settings.minCollateralRatio = event.overrideSettings.minCollateralRatio
            if (event.overrideSettings.LMToken)
                settings.LMToken = event.overrideSettings.LMToken
        }

        if (event.checkSetup) {
            if (CheckProgram.canDoCheck(settings)) {
                const program = new CheckProgram(settings, new WalletSetup(MainNet, settings))
                await program.init()
                await program.reportCheck(telegram)
                return { statusCode: 200 }
            } else {
                const message = CheckProgram.buildCurrentSettingsIntoMessage(settings)
                console.log(message)
                await telegram.log(message)
                await telegram.send(message)
                return {
                    statusCode: 500,
                    message: message
                }
            }
        }
    }


    const program = new VaultMaxiProgram(settings, new WalletSetup(MainNet, settings))
    await program.init()
    if (! await program.isValid()) {
        await telegram.send("Configuration error. please check your values")
        return {
            statusCode: 500
        }
    }

    const vaultcheck = await program.getVault()
    if(!vaultcheck) {
        console.error("Did not find vault")
        await telegram.send("Error: vault is gone ")
        return {
            statusCode: 500
        }
    }
    if (vaultcheck.state == LoanVaultState.FROZEN || vaultcheck.state == LoanVaultState.IN_LIQUIDATION) {
        await telegram.send("Error: vault not active, its " + vaultcheck.state)
        console.error("Vault not active: "+vaultcheck.state)
        return {
            statusCode: 500
        }
    }

    let vault: LoanVaultActive = vaultcheck
    if(+vault.collateralValue < 10) {
        await telegram.send("less than 10 dollar in the vault, can't work with that")
        console.error("less than 10 dollar in the vault. can't work like that")
        return {statusCode:500}
    }
    const nextCollateralRatio = program.nextCollateralRatio(vault)
    const usedCollateralRatio= Math.min(+vault.collateralRatio, nextCollateralRatio)
    console.log("starting with " + vault.collateralRatio + " (next: "+nextCollateralRatio+") in vault, target " + settings.minCollateralRatio + " - " + settings.maxCollateralRatio + " token " + settings.LMToken)

    let result = true
    let exposureChanged= false
    if (0 < usedCollateralRatio && usedCollateralRatio < settings.minCollateralRatio) {
        result = await program.decreaseExposure(vault, telegram)
        exposureChanged= true
    } else if (usedCollateralRatio < 0 || usedCollateralRatio > settings.maxCollateralRatio) {
        result = await program.increaseExposure(vault, telegram)
        exposureChanged= true
    } else {
        result = true
        exposureChanged= await program.checkAndDoReinvest(vault, telegram)
    }
    
    if (exposureChanged) {
        const oldRatio = +vault.collateralRatio
        const oldNext = nextCollateralRatio
        vault = await program.getVault() as LoanVaultActive
        await telegram.log("executed script " + (result ? "successfully" : "with problems") 
                + ". vault ratio changed from " + oldRatio + " (next " + oldNext + ") to " 
                + vault.collateralRatio + " (next " + program.nextCollateralRatio(vault) + ")")
    } else {
        await telegram.log("executed script without changes. vault ratio " 
                + vault.collateralRatio + " next " + program.nextCollateralRatio(vault))
    }
    return {
        statusCode: result ? 200 : 500
    }
}