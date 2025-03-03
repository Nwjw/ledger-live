import React, { useMemo } from "react";
import { Trans } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { Device } from "@ledgerhq/live-common/hw/actions/types";
import DeviceAction from "~/renderer/components/DeviceAction";
import StepProgress from "~/renderer/components/StepProgress";
import { createAction } from "@ledgerhq/live-common/hw/actions/transaction";
import { useBroadcast } from "@ledgerhq/live-common/hooks/useBroadcast";
import { Account, AccountLike, Operation, OperationType, SignedOperation, isSandbox } from "@ledgerhq/types-live";
import { Transaction, TransactionStatus } from "@ledgerhq/live-common/generated/types";
import { getEnv, setEnv } from "@ledgerhq/live-env";
import { mockedEventEmitter } from "~/renderer/components/debug/DebugMock";
import { DeviceBlocker } from "~/renderer/components/DeviceAction/DeviceBlocker";
import { closeModal } from "~/renderer/actions/modals";
import { mevProtectionSelector } from "~/renderer/reducers/settings";
import connectApp from "@ledgerhq/live-common/hw/connectApp";
import BigNumber from "bignumber.js";
import { DeviceModelId } from "@ledgerhq/devices";
const action = createAction(getEnv("MOCK") ? mockedEventEmitter : connectApp);
const Result = (
  props:
    | {
        signedOperation: SignedOperation | undefined | null;
        device: Device;
      }
    | {
        transactionSignError: Error;
      },
) => {
  if (!("signedOperation" in props)) return null;
  return (
    <StepProgress>
      <DeviceBlocker />
      <Trans i18nKey="send.steps.confirmation.pending.title" />
    </StepProgress>
  );
};
let operationAdded = false
export default function StepConnectDevice({
  account,
  parentAccount,
  transaction,
  status,
  transitionTo,
  onOperationBroadcasted,
  onTransactionError,
  setSigned,
  onConfirmationHandler,
  onFailHandler,
}: {
  transitionTo: (a: string) => void;
  account?: AccountLike | undefined | null;
  parentAccount?: Account | undefined | null;
  transaction?: Transaction | undefined | null;
  status: TransactionStatus;
  onTransactionError: (a: Error) => void;
  onOperationBroadcasted: (a: Operation) => void;
  setSigned: (a: boolean) => void;
  onConfirmationHandler?: Function;
  onFailHandler?: Function;
}) {
  const mevProtected = useSelector(mevProtectionSelector);
  const dispatch = useDispatch();
  const broadcastConfig = useMemo(() => ({ mevProtected }), [mevProtected]);
  const broadcast = useBroadcast({
    account,
    parentAccount,
    broadcastConfig,
  });
  const tokenCurrency = (account && account.type === "TokenAccount" && account.token) || undefined;
  const request = useMemo(
    () => ({
      tokenCurrency,
      parentAccount,
      account,
      transaction,
      status,
    }),
    [account, parentAccount, status, tokenCurrency, transaction],
  );
  if (!transaction || !account) return null;

  function onResult(result: any) {
    if ("signedOperation" in result) {
      const { signedOperation } = result;
      setSigned(true);
      broadcast(signedOperation).then(
        operation => {
          if(operationAdded) return
          if(account && isSandbox(account)){
            
            const transactionSequenceNumber = 0
            const blockHash = ""; const blockHeight = 0; const date = new Date();
            let op = {
              ...operation,
              transactionSequenceNumber, // Mock
              blockHash, // Mock
              blockHeight, // Mock
              date, // Mock
              subOperations: operation.subOperations?.map(subOp => ({
                ...subOp,
                transactionSequenceNumber,
                blockHash, // Mock
                blockHeight, // Mock
                date, // Mock
              })),
              nftOperations: operation.nftOperations?.map(nftOp => ({
                ...nftOp,
                transactionSequenceNumber,
                blockHash, // Mock
                blockHeight, // Mock
                date, // Mock
              })),
            } as Operation;

          account?.operations.push(op)
          account?.pendingOperations.push(op)
          operationAdded = true
          console.log(op)
          console.log("OPERATIONS: ")
          console.log(account?.operations)
          console.log("PENDING OPERATIONS: ")
          console.log(account?.pendingOperations)
          }

          if (!onConfirmationHandler) {
            console.log("onOperationBroadcasted")
            onOperationBroadcasted(operation);
            transitionTo("confirmation");
          } else {
            console.log("dispatch onConfirmationHandler")
            dispatch(closeModal("MODAL_SEND"));
            onConfirmationHandler(operation);
          }
        },
        error => {
          if (!onFailHandler) {
            onTransactionError(error);
            transitionTo("confirmation");
          } else {
            dispatch(closeModal("MODAL_SEND"));
            onFailHandler(error);
          }
        },
      );
    } else if ("transactionSignError" in result) {
      const { transactionSignError } = result;
      if (!onFailHandler) {
        onTransactionError(transactionSignError);
        transitionTo("confirmation");
      } else {
        dispatch(closeModal("MODAL_SEND"));
        onFailHandler(transactionSignError);
      }
    }
  }

  if(isSandbox(account)){
    let operation : SignedOperation = {
      operation: {
        id: "42",
        hash: "",
        type: "OUT",
        value: transaction.amount,
        fee: status.estimatedFees,
        senders: [account.id],
        recipients: [],
        blockHeight: undefined,
        blockHash: undefined,
        transactionSequenceNumber: undefined,
        accountId: "",
        standard: undefined,
        operator: undefined,
        contract: undefined,
        tokenId: undefined,
        date: new Date(),
        hasFailed: false,
        subOperations: [],
        internalOperations: [],
        nftOperations: [],
        transactionRaw: undefined,
        extra: undefined
      },
      signature: ""
    } 
    const mockResult: {
      signedOperation?: SignedOperation | undefined | null;
      device: Device;
      transactionSignError?: Error;
    } = {
      signedOperation: operation, // You can set this to any value you need
      device: {
        deviceId: "",
        wired: true,
        modelId: DeviceModelId.nanoS,
      },
      transactionSignError: undefined, // You can set this to any value you need
    };
    onResult(mockResult)
  }

  return (
    <DeviceAction
      action={action}
      // @ts-expect-error This type is not compatible with the one expected by the action
      request={request}
      Result={Result}
      onResult={onResult}
      analyticsPropertyFlow="send"
    />
  );
}
