using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class AddOemInvoicePaidFlag : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "OemInvoicePaid",
                table: "CarePackBatches",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<DateTime>(
                name: "OemInvoicePaidAt",
                table: "CarePackBatches",
                type: "datetime",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OemInvoicePaidBy",
                table: "CarePackBatches",
                type: "nvarchar(100)",
                maxLength: 100,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "OemInvoicePaid",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "OemInvoicePaidAt",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "OemInvoicePaidBy",
                table: "CarePackBatches");
        }
    }
}
